import * as THREE from "three";
import { PolyLine } from "./PolyLine";

export interface PathRenderer {
  readonly object: THREE.Object3D;
  setPoints(points: readonly THREE.Vector3[]): void;
  setVisible(visible: boolean): void;
  update(time: number): void;
  onResize(width: number, height: number): void;
}

export interface ScreenProjection {
  x: number;
  y: number;
  visible: boolean;
}

export interface MeasureLineToolOptions {
  scene: THREE.Scene;
  getPickPosition: (
    normalizedX: number,
    normalizedY: number,
  ) => THREE.Vector3 | null;
  projectToScreen: (position: THREE.Vector3) => ScreenProjection;
  onComplete?: () => void;
}

type MeasureState = "idle" | "awaitingStart" | "awaitingPoint" | "complete";

interface Marker {
  container: HTMLElement;
}

interface SegmentLabel {
  el: HTMLElement;
  text: HTMLSpanElement;
  input: HTMLInputElement;
}

/**
 * Local, non-Gemini interaction tool: click through a sequence of points on
 * the splat to drop a continuous glowing polyline with START/END markers, a
 * per-segment distance label, and a total-route badge.
 */
export class MeasureLineTool {
  private state: MeasureState = "idle";
  private points: THREE.Vector3[] = [];
  private readonly glowLine: PathRenderer;
  private readonly previewPoints: THREE.Vector3[] = [];
  private readonly startMarker: Marker;
  private readonly endMarker: Marker;
  private readonly segmentLabels: SegmentLabel[] = [];
  private readonly totalLabel: HTMLElement;
  private readonly totalLabelText: HTMLSpanElement;
  private time = 0;

  constructor(private readonly opts: MeasureLineToolOptions) {
    this.glowLine = new PolyLine();
    this.opts.scene.add(this.glowLine.object);

    this.startMarker = this.createMarker("START");
    this.endMarker = this.createMarker("END");

    const { totalLabel, totalLabelText } = this.createTotalBadge();
    this.totalLabel = totalLabel;
    this.totalLabelText = totalLabelText;

    document.body.appendChild(this.startMarker.container);
    document.body.appendChild(this.endMarker.container);
    document.body.appendChild(this.totalLabel);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.finish();
    });
  }

  get isArmed(): boolean {
    return this.state === "awaitingStart" || this.state === "awaitingPoint";
  }

  getPoints(): readonly THREE.Vector3[] {
    return this.points;
  }

  activate(): void {
    if (this.state !== "idle") {
      this.clear();
    }
    this.state = "awaitingStart";
  }

  deactivate(): void {
    if (this.isArmed) {
      this.clear();
    }
  }

  handleClick(normalizedX: number, normalizedY: number): void {
    if (!this.isArmed) return;

    const worldPos = this.opts.getPickPosition(normalizedX, normalizedY);
    if (!worldPos) return;

    if (this.state === "awaitingStart") {
      this.points = [worldPos.clone()];
      this.startMarker.container.classList.remove("hidden");
      this.state = "awaitingPoint";
      return;
    }

    // Each subsequent click commits a segment ending at this exact point.
    // Keep the tool armed so the next preview/segment starts here.
    this.points.push(worldPos.clone());
    this.glowLine.setPoints(this.points);
    this.positionEndMarker();
    this.addSegmentLabel();
  }

  handlePointerMove(normalizedX: number, normalizedY: number): void {
    if (this.state !== "awaitingPoint" || this.points.length === 0) return;
    const hoverPos = this.opts.getPickPosition(normalizedX, normalizedY);
    if (!hoverPos) return;
    this.previewPoints.length = this.points.length;
    for (let i = 0; i < this.points.length; i += 1) {
      this.previewPoints[i] = this.points[i];
    }
    this.previewPoints.push(hoverPos);
    this.glowLine.setPoints(this.previewPoints);
  }

  finish(): void {
    if (this.state !== "awaitingPoint" || this.points.length < 2) return;
    this.positionEndMarker();
    this.state = "complete";
    const last = this.segmentLabels[this.segmentLabels.length - 1];
    if (last) this.showLabelForEditing(last);
    this.updateTotalLabel();
    this.opts.onComplete?.();
  }

  update(dt: number): void {
    this.time += dt;
    this.glowLine.update(this.time);

    if (this.points[0]) {
      this.positionMarker(this.startMarker, this.points[0]);
    }
    if (this.points.length > 1) {
      const end = this.points[this.points.length - 1];
      this.positionMarker(this.endMarker, end);
      this.positionTotalLabel(end);
    }

    for (let i = 0; i < this.segmentLabels.length; i += 1) {
      const mid = this.points[i]
        .clone()
        .add(this.points[i + 1])
        .multiplyScalar(0.5);
      this.positionLabel(this.segmentLabels[i].el, mid);
    }
  }

  onResize(width: number, height: number): void {
    this.glowLine.onResize(width, height);
  }

  private clear(): void {
    this.points = [];
    this.glowLine.setVisible(false);
    this.startMarker.container.classList.add("hidden");
    this.endMarker.container.classList.add("hidden");
    for (const segment of this.segmentLabels) {
      segment.el.remove();
    }
    this.segmentLabels.length = 0;
    this.totalLabel.classList.add("hidden");
    this.totalLabelText.textContent = "Total: —";
    this.state = "idle";
  }

  private addSegmentLabel(): void {
    const segment = this.createSegmentLabel();
    this.segmentLabels.push(segment);
    document.body.appendChild(segment.el);
  }

  private positionEndMarker(): void {
    const end = this.points[this.points.length - 1];
    if (!end) return;
    this.endMarker.container.classList.remove("hidden");
    this.positionMarker(this.endMarker, end);
  }

  private positionMarker(marker: Marker, position: THREE.Vector3): void {
    const { x, y, visible } = this.opts.projectToScreen(position);
    marker.container.classList.toggle("hidden", !visible);
    marker.container.style.left = `${x}px`;
    marker.container.style.top = `${y}px`;
  }

  private positionLabel(el: HTMLElement, position: THREE.Vector3): void {
    const { x, y, visible } = this.opts.projectToScreen(position);
    el.classList.toggle("hidden", !visible);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // Offset so the total badge sits beside the end marker rather than on
  // top of it (see the "Total Route" placement in the reference mock).
  private positionTotalLabel(endPosition: THREE.Vector3): void {
    if (this.state !== "complete" || this.segmentLabels.length < 2) {
      this.totalLabel.classList.add("hidden");
      return;
    }
    const { x, y, visible } = this.opts.projectToScreen(endPosition);
    this.totalLabel.classList.toggle("hidden", !visible);
    this.totalLabel.style.left = `${x + 60}px`;
    this.totalLabel.style.top = `${y - 40}px`;
  }

  private createMarker(caption: string): Marker {
    const container = document.createElement("div");
    container.className = "measure-marker hidden";

    const pin = document.createElement("div");
    pin.className = "measure-pin";

    const captionEl = document.createElement("div");
    captionEl.className = "measure-caption";
    captionEl.textContent = caption;

    container.appendChild(pin);
    container.appendChild(captionEl);
    return { container };
  }

  private createSegmentLabel(): SegmentLabel {
    const el = document.createElement("div");
    el.className = "measure-label";

    const text = document.createElement("span");
    text.className = "measure-label__text hidden";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "measure-label__input";
    input.placeholder = "e.g. 300 m";

    const segment: SegmentLabel = { el, text, input };

    text.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openLabelForEditing(segment);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => this.commitLabelText(segment));
    input.addEventListener("keydown", (e) => {
      // Stop this from bubbling to the document-level Enter handler, which
      // would otherwise end the whole polyline while a segment is mid-edit.
      if (e.key === "Enter") {
        e.stopPropagation();
        input.blur();
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "measure-label__remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
    });

    el.appendChild(text);
    el.appendChild(input);
    el.appendChild(removeBtn);

    return segment;
  }

  private createTotalBadge(): {
    totalLabel: HTMLElement;
    totalLabelText: HTMLSpanElement;
  } {
    const totalLabel = document.createElement("div");
    totalLabel.className = "measure-label measure-label--total hidden";

    const totalLabelText = document.createElement("span");
    totalLabelText.className = "measure-label__text";
    totalLabelText.textContent = "Total: —";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "measure-label__remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
    });

    totalLabel.appendChild(totalLabelText);
    totalLabel.appendChild(removeBtn);

    return { totalLabel, totalLabelText };
  }

  private showLabelForEditing(segment: SegmentLabel): void {
    segment.text.classList.add("hidden");
    segment.input.classList.remove("hidden");
    segment.input.value = "";
    requestAnimationFrame(() => segment.input.focus());
  }

  private openLabelForEditing(segment: SegmentLabel): void {
    segment.input.value = segment.text.textContent ?? "";
    segment.text.classList.add("hidden");
    segment.input.classList.remove("hidden");
    requestAnimationFrame(() => segment.input.focus());
  }

  private commitLabelText(segment: SegmentLabel): void {
    const value = segment.input.value.trim();
    segment.text.textContent = value;
    const hasValue = value.length > 0;
    segment.text.classList.toggle("hidden", !hasValue);
    segment.input.classList.toggle("hidden", hasValue);
    this.updateTotalLabel();
  }

  // Sums the leading numeric value out of each segment's free-typed label
  // (e.g. "300 m") since distances are user-entered, not scene-calibrated.
  private updateTotalLabel(): void {
    let sum = 0;
    let unit = "";
    let any = false;

    for (const segment of this.segmentLabels) {
      const match = segment.text.textContent
        ?.trim()
        .match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
      if (match) {
        sum += parseFloat(match[1]);
        if (!unit && match[2]) unit = match[2];
        any = true;
      }
    }

    this.totalLabelText.textContent = any
      ? `Total: ${Number(sum.toFixed(2))}${unit ? ` ${unit}` : ""}`
      : "Total: —";
  }
}
