import * as THREE from "three";
import { GlowLine } from "./GlowLine";

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

type MeasureState = "idle" | "awaitingStart" | "awaitingEnd" | "complete";

interface Marker {
  container: HTMLElement;
}

/**
 * Local, non-Gemini interaction tool: click two points on the splat to drop
 * a glowing measurement line with START/END markers and a user-typed
 * distance label. `points` is kept as an array so a future polyline/route
 * mode can extend this without rework (see MEASURE_LINE_PLAN.md §4).
 */
export class MeasureLineTool {
  private state: MeasureState = "idle";
  private points: THREE.Vector3[] = [];
  private readonly glowLine: GlowLine;
  private readonly startMarker: Marker;
  private readonly endMarker: Marker;
  private readonly labelEl: HTMLElement;
  private readonly labelText: HTMLSpanElement;
  private readonly labelInput: HTMLInputElement;
  private time = 0;

  constructor(private readonly opts: MeasureLineToolOptions) {
    this.glowLine = new GlowLine();
    this.opts.scene.add(this.glowLine.object);

    this.startMarker = this.createMarker("START");
    this.endMarker = this.createMarker("END");

    const { labelEl, labelText, labelInput } = this.createLabel();
    this.labelEl = labelEl;
    this.labelText = labelText;
    this.labelInput = labelInput;

    document.body.appendChild(this.startMarker.container);
    document.body.appendChild(this.endMarker.container);
    document.body.appendChild(this.labelEl);
  }

  get isArmed(): boolean {
    return this.state === "awaitingStart" || this.state === "awaitingEnd";
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
      this.state = "awaitingEnd";
      return;
    }

    // awaitingEnd
    this.points[1] = worldPos.clone();
    this.glowLine.setEndpoints(this.points[0], this.points[1]);
    this.endMarker.container.classList.remove("hidden");
    this.state = "complete";
    this.showLabelForEditing();
    this.opts.onComplete?.();
  }

  handlePointerMove(normalizedX: number, normalizedY: number): void {
    if (this.state !== "awaitingEnd" || this.points.length === 0) return;
    const hoverPos = this.opts.getPickPosition(normalizedX, normalizedY);
    if (!hoverPos) return;
    this.glowLine.setEndpoints(this.points[0], hoverPos);
  }

  update(dt: number): void {
    this.time += dt;
    this.glowLine.update(this.time);

    if (this.points[0]) {
      this.positionMarker(this.startMarker, this.points[0]);
    }
    if (this.points[1]) {
      this.positionMarker(this.endMarker, this.points[1]);
      this.positionLabel(this.glowLine.getMidpoint());
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
    this.labelEl.classList.add("hidden");
    this.state = "idle";
  }

  private positionMarker(marker: Marker, position: THREE.Vector3): void {
    const { x, y, visible } = this.opts.projectToScreen(position);
    marker.container.classList.toggle("hidden", !visible);
    marker.container.style.left = `${x}px`;
    marker.container.style.top = `${y}px`;
  }

  private positionLabel(position: THREE.Vector3): void {
    const { x, y, visible } = this.opts.projectToScreen(position);
    this.labelEl.classList.toggle("hidden", !visible);
    this.labelEl.style.left = `${x}px`;
    this.labelEl.style.top = `${y}px`;
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

  private createLabel(): {
    labelEl: HTMLElement;
    labelText: HTMLSpanElement;
    labelInput: HTMLInputElement;
  } {
    const labelEl = document.createElement("div");
    labelEl.className = "measure-label hidden";

    const labelText = document.createElement("span");
    labelText.className = "measure-label__text hidden";
    labelText.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openLabelForEditing();
    });

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "measure-label__input";
    labelInput.placeholder = "e.g. 300 m";
    labelInput.addEventListener("click", (e) => e.stopPropagation());
    labelInput.addEventListener("blur", () => this.commitLabelText());
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") labelInput.blur();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "measure-label__remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
    });

    labelEl.appendChild(labelText);
    labelEl.appendChild(labelInput);
    labelEl.appendChild(removeBtn);

    return { labelEl, labelText, labelInput };
  }

  private showLabelForEditing(): void {
    this.labelEl.classList.remove("hidden");
    this.labelText.classList.add("hidden");
    this.labelInput.classList.remove("hidden");
    this.labelInput.value = "";
    requestAnimationFrame(() => this.labelInput.focus());
  }

  private openLabelForEditing(): void {
    this.labelInput.value = this.labelText.textContent ?? "";
    this.labelText.classList.add("hidden");
    this.labelInput.classList.remove("hidden");
    requestAnimationFrame(() => this.labelInput.focus());
  }

  private commitLabelText(): void {
    const value = this.labelInput.value.trim();
    this.labelText.textContent = value;
    const hasValue = value.length > 0;
    this.labelText.classList.toggle("hidden", !hasValue);
    this.labelInput.classList.toggle("hidden", hasValue);
  }
}
