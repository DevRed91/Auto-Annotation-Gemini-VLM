import * as THREE from "three";
import {
  SparkControls,
  SparkRenderer,
  SplatMesh,
  dyno,
} from "@sparkjsdev/spark";
import {
  getMobileInput,
  getMobileLook,
  initMobileControls,
  isMobileDevice,
} from "./utils/mobileJoystick";
import GeometricContextManager from "./GeometricContextManager/GeometricContextManager";
import type { CandidatePoint } from "./compute/types";
import { MeasureLineTool, type ScreenProjection } from "./measure/MeasureLineTool";
import { diagnose, buildDiagnoseEndpoint } from "./flaw/diagnosisClient";
import { decodeRegions } from "./flaw/regions";
import { GaussianStore } from "./flaw/GaussianStore";
import type { EditRecord, LiftResult, Region } from "./flaw/types";
import { liftRegion } from "./flaw/lift";
import { buildWorldAttributes, createHighlight, disposeHighlight, editableSplats, syncSplats } from "./flaw/preview";
import { RectificationHistory, rectificationNotice } from "./flaw/rectify";
import { downloadRectifiedPly } from "./flaw/exportPly";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || "/api";
const BYPASS_TUNNEL_REMINDER =
  (import.meta.env.VITE_BYPASS_TUNNEL_REMINDER as string | undefined) ===
  "true";

function buildAnnotateEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");

  if (normalized.endsWith("/annotate")) {
    return normalized;
  }
  if (normalized.endsWith("/api")) {
    return `${normalized}/annotate`;
  }
  if (normalized.startsWith("http")) {
    return `${normalized}/api/annotate`;
  }
  return `${normalized}/annotate`;
}

interface AnnotationDetection {
  label: string;
  box: [number, number, number, number];
}

interface DimensionSet {
  width: number;
  height: number;
  depth: number;
}

const CandidateFlags = {
  DepthValid: 1 << 0,
  RaycastValid: 1 << 1,
  UsedDepthPosition: 1 << 2,
  UsedRaycastPosition: 1 << 3,
  DepthResidualValid: 1 << 4,
} as const;

export class SplatViewer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private spark: SparkRenderer;
  private controls: SparkControls;
  private currentSplat: SplatMesh | null = null;
  private isMobile: boolean = isMobileDevice();
  private cameraRig = new THREE.Group();
  private animateT = dyno.dynoFloat(0);
  private baseTime = 0;
  private splatLoaded = false;
  private annotations: { element: HTMLElement; position: THREE.Vector3 }[] = [];
  private activeTool: "none" | "annotate" | "diagnose" | "measure" = "none";
  private pointerDownPos: { x: number; y: number } | null = null;
  private annotationLoadingEl: HTMLElement | null = null;
  private annotationToolButton: HTMLButtonElement | null = null;
  private diagnoseToolButton: HTMLButtonElement | null = null;
  private measureToolButton: HTMLButtonElement | null = null;
  private measureTool: MeasureLineTool | null = null;
  private readonly geometricContext = new GeometricContextManager();
  private activeBoxHelper: THREE.Box3Helper | null = null;
  private gaussianStore: GaussianStore | null = null;
  private worldLoadVersion = 0;
  private worldLoadController: AbortController | null = null;
  private diagnosisPending = false;
  private diagnosisVersion = 0;
  private diagnosisPanel: HTMLElement | null = null;
  private rectificationHistory = new RectificationHistory();
  private worldAttributes: ReturnType<typeof buildWorldAttributes> | null = null;
  private selection: LiftResult | null = null;
  private selectionHighlight: THREE.Points | null = null;
  private sceneName = "scene";

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.01,
      1000,
    );
    this.cameraRig = new THREE.Group();
    this.cameraRig.add(this.camera);
    this.cameraRig.position.set(0, 0, -3);
    this.cameraRig.rotateY(Math.PI);
    this.scene.add(this.cameraRig);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(this.renderer.domElement);
    this.controls = new SparkControls({ canvas: this.renderer.domElement });

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.measureTool = new MeasureLineTool({
      scene: this.scene,
      getPickPosition: (x, y) => this.getAnnotationPosition(x, y),
      projectToScreen: (position) => this.projectToScreen(position),
      onComplete: () => {
        this.activeTool = "none";
        this.measureToolButton?.classList.remove("active");
      },
    });

    this.setMobileControls();
    this.setupEventListeners();
    this.setupAnnotationUI();
    this.setupDiagnosisUI();
    this.setupMeasureUI();
    // this.setupSelectionBox();
    this.setupClickInteraction();
    this.setupLoadingUI();
    this.startAnimationLoop();
  }

  private setupLoadingUI() {
    const loadingEl = document.createElement("div");
    loadingEl.className = "annotation-loading hidden";
    loadingEl.innerHTML = `
      <div class="annotation-loading__spinner"></div>
      <span>Fetching annotation...</span>
    `;
    document.body.appendChild(loadingEl);
    this.annotationLoadingEl = loadingEl;
  }

  private setAnnotationLoading(isLoading: boolean) {
    if (!this.annotationLoadingEl) return;
    this.annotationLoadingEl.classList.toggle("hidden", !isLoading);
  }

  private setupEventListeners() {
    window.addEventListener("resize", () => this.onWindowResize());
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.measureTool?.onResize(window.innerWidth, window.innerHeight);
  }

  private startAnimationLoop() {
    let lastTime = performance.now();
    this.renderer.setAnimationLoop((time) => {
      this.controls.update(this.cameraRig);
      this.camera.updateMatrixWorld();
      const MOVE_SPEED = 2.0;
      const deltaTime = (time - lastTime) / 1000;
      lastTime = time;
      if (this.splatLoaded) {
        this.baseTime += 1 / 60;
        this.animateT.value = this.baseTime;
      } else {
        this.animateT.value = 0;
      }

      this.updateMobileControls(deltaTime, MOVE_SPEED);
      this.updateAnnotationLabels();
      this.measureTool?.update(deltaTime);
      this.renderer.render(this.scene, this.camera);
    });
  }

  private setupClickInteraction() {
    const el = this.renderer.domElement;

    el.addEventListener("pointerdown", (e) => {
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener("pointermove", (e) => {
      if (this.activeTool !== "measure") return;
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      this.measureTool?.handlePointerMove(x, y);
    });

    el.addEventListener("click", (e) => {
      // SparkControls captures the pointer on orbit-drag but never
      // suppresses the trailing click — ignore clicks that moved more
      // than a few pixels so camera drags don't mis-fire either tool.
      const downPos = this.pointerDownPos;
      this.pointerDownPos = null;
      if (downPos) {
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > 5) return;
      }

      if (this.activeTool === "none") return;

      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      if (this.activeTool === "measure") {
        this.measureTool?.handleClick(x, y);
        return;
      }
      if (this.activeTool === "diagnose") {
        void this.requestDiagnosisFromGemini(x, y);
        return;
      }

      const clickWorldPos = this.getAnnotationPosition(x, y);
      console.log(`User clicked at: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      this.requestAnnotationFromGemini(x, y, clickWorldPos);
    });
  }
  private setupAnnotationUI() {
    const btn = document.getElementById("annotationToolButton");
    if (btn) {
      this.annotationToolButton = btn as HTMLButtonElement;
      btn.addEventListener("click", () => {
        if ((btn as HTMLButtonElement).disabled) return;
        const activating = !btn.classList.contains("active");
        if (activating) {
          this.measureToolButton?.classList.remove("active");
          this.diagnoseToolButton?.classList.remove("active");
          this.closeDiagnosisPanel();
          this.measureTool?.deactivate();
          this.activeTool = "annotate";
          btn.classList.add("active");
        } else {
          this.activeTool = "none";
          btn.classList.remove("active");
        }
      });
    }
  }

  private setupDiagnosisUI() {
    const btn = document.getElementById("diagnoseToolButton");
    if (!btn) return;
    this.diagnoseToolButton = btn as HTMLButtonElement;
    btn.addEventListener("click", () => {
      const activating = !btn.classList.contains("active");
      if (activating) {
        this.annotationToolButton?.classList.remove("active");
        this.measureToolButton?.classList.remove("active");
        this.measureTool?.deactivate();
        this.activeTool = "diagnose";
        btn.classList.add("active");
      } else {
        this.activeTool = "none";
        btn.classList.remove("active");
        this.closeDiagnosisPanel();
      }
    });
  }

  private setupMeasureUI() {
    const btn = document.getElementById("measureToolButton");
    if (!btn) return;
    this.measureToolButton = btn as HTMLButtonElement;
    btn.addEventListener("click", () => {
      if ((btn as HTMLButtonElement).disabled) return;
      const activating = !btn.classList.contains("active");
      if (activating) {
        this.annotationToolButton?.classList.remove("active");
        this.diagnoseToolButton?.classList.remove("active");
        this.closeDiagnosisPanel();
        this.activeTool = "measure";
        btn.classList.add("active");
        this.measureTool?.activate();
      } else {
        this.activeTool = "none";
        btn.classList.remove("active");
        this.measureTool?.deactivate();
      }
    });
  }

  private disableAnnotationToolButton() {
    if (!this.annotationToolButton) return;
    this.annotationToolButton.disabled = true;
    this.annotationToolButton.classList.toggle("disabled", true);
    this.annotationToolButton.classList.remove("active");
    if (this.activeTool === "annotate") this.activeTool = "none";
  }

  private projectToScreen(position: THREE.Vector3): ScreenProjection {
    const pos = position.clone().project(this.camera);
    const visible = pos.z <= 1;
    const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-pos.y * 0.5 + 0.5) * window.innerHeight;
    return { x, y, visible };
  }

  private updateAnnotationLabels() {
    this.annotations.forEach((ann) => {
      // Check if element exists
      if (!ann.element) return;

      const { x, y, visible } = this.projectToScreen(ann.position);
      if (!visible) {
        ann.element.style.display = "none";
      } else {
        ann.element.style.display = "block";
        ann.element.style.left = `${x}px`;
        ann.element.style.top = `${y}px`;
      }
    });
  }

  private updateMobileControls(deltaTime: number, moveSpeed: number) {
    if (!this.isMobile) {
      return;
    }

    const input = getMobileInput();
    const look = getMobileLook();
    const LOOK_SPEED = 0.005;

    if (look.x !== 0 || look.y !== 0) {
      this.cameraRig.rotateY(-look.x * LOOK_SPEED);
      this.camera.rotateX(-look.y * LOOK_SPEED);

      const maxPitch = Math.PI / 2.1;
      this.camera.rotation.x = Math.max(
        -maxPitch,
        Math.min(maxPitch, this.camera.rotation.x),
      );
    }

    if (input.x !== 0 || input.y !== 0) {
      const move = new THREE.Vector3(input.x, 0, input.y);
      move.multiplyScalar(moveSpeed * deltaTime);
      move.applyQuaternion(this.cameraRig.quaternion);
      move.y = 0; // Stay grounded — don't let pitch affect vertical position
      this.cameraRig.position.add(move);
    }
  }

  private setMobileControls() {
    // const info = document.getElementById('info');

    if (this.isMobile) {
      initMobileControls({
        joystickSize: 140,
        knobSize: 60,
        marginLeft: 40,
        marginBottom: 40,
      });
    }
  }

  private addGroundPlane() {
    const geometry = new THREE.PlaneGeometry(100, 100);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    const plane = new THREE.Mesh(geometry, material);
    plane.name = "GroundPlane";
    plane.rotation.x = -Math.PI / 2; // horizontal floor
    plane.position.set(0, -1.7, 0);
    plane.visible = true;
    plane.receiveShadow = false;

    this.scene.add(plane);
  }

  public async loadWorld(url: string) {
    const version = ++this.worldLoadVersion;
    this.worldLoadController?.abort();
    const controller = new AbortController();
    this.worldLoadController = controller;
    this.closeDiagnosisPanel();
    let store: GaussianStore | null = null;
    let fileBytes: ArrayBuffer | undefined;
    if (/\.ply(?:$|[?#])/i.test(url)) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load PLY (${response.status})`);
        fileBytes = await response.arrayBuffer();
      } catch (error) {
        if (version !== this.worldLoadVersion) return;
        throw error;
      }
    }
    if (version !== this.worldLoadVersion) return;
    const splat = new SplatMesh(fileBytes ? { fileBytes, fileName: "scene.ply", lod: false } : { url });
    splat.quaternion.set(1, 0, 0, 0);
    splat.position.set(0, -1.5, 0);
    // Attach immediately; editable-store parsing must not delay the renderer.
    const previousSplat = this.currentSplat;
    this.scene.add(splat);
    this.currentSplat = splat;
    this.gaussianStore = null;
    this.worldAttributes = null;
    this.rectificationHistory = new RectificationHistory();
    this.sceneName = url.split(/[?#]/)[0].split("/").pop() || "scene";
    if (previousSplat) {
      this.scene.remove(previousSplat);
      previousSplat.dispose();
    }
    if (fileBytes) {
      try {
        store = GaussianStore.fromBytes(fileBytes);
        console.info(`Editable Gaussian store loaded: ${store.vertexCount.toLocaleString()} splats`);
      } catch (error) {
        console.warn("PLY editing is unavailable for this scene:", error);
      }
    }
    this.gaussianStore = store;
    this.splatLoaded = false;
    try {
      await splat.initialized;
    } catch (error) {
      if (version !== this.worldLoadVersion) return;
      this.scene.remove(splat);
      splat.dispose();
      this.currentSplat = null;
      this.gaussianStore = null;
      throw error;
    }
    if (version !== this.worldLoadVersion) return;
    this.splatLoaded = true;
    if (!this.scene.getObjectByName("GroundPlane")) this.addGroundPlane();
  }

  private getAnnotationPosition(
    normalizedX: number,
    normalizedY: number,
  ): THREE.Vector3 | null {
    // 1. Convert normalized 0-1 to NDC (-1 to 1)
    const ndcX = normalizedX * 2 - 1;
    const ndcY = -(normalizedY * 2 - 1);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    // 2. Intersect with the SplatMesh
    if (this.currentSplat) {
      const intersects = raycaster.intersectObject(this.currentSplat);
      if (intersects.length > 0) {
        return intersects[0].point; // This is your 3D position
      }
    }
    return null;
  }
  // Create a simple UI helper function
  // private createAnnotationElement(position: THREE.Vector3, label: string) {
  //   const div = document.createElement("div");
  //   div.className = "annotation-label";
  //   div.innerText = label;
  //   div.style.position = "absolute";
  //   div.style.zIndex = "1000"; // Ensure it's on top of canvas
  //   div.style.pointerEvents = "none"; // So clicks pass through
  //   div.style.backgroundColor = "rgba(0,0,0,0.6)";
  //   div.style.color = "white";
  //   div.style.padding = "4px 8px";
  //   div.style.borderRadius = "4px";
  //   document.body.appendChild(div);

  //   this.annotations.push({ element: div, position });
  // }
  private getDepthKernel(x: number, y: number): number {
    const gl = this.renderer.getContext();
    const kernelSize = 2; // 5x5 grid
    let minDepth = 1.0;
    const pixelBuffer = new Float32Array(1);
    const canvasHeight = this.renderer.domElement.height;

    for (let i = -kernelSize; i <= kernelSize; i++) {
      for (let j = -kernelSize; j <= kernelSize; j++) {
        const px = Math.max(
          0,
          Math.min(this.renderer.domElement.width - 1, x + i),
        );
        const py = Math.max(
          0,
          Math.min(this.renderer.domElement.height - 1, y + j),
        );

        // WebGL coordinate flip: (0,0) is bottom-left in GL, top-left in Browser
        const glY = canvasHeight - py;

        gl.readPixels(px, glY, 1, 1, gl.DEPTH_COMPONENT, gl.FLOAT, pixelBuffer);

        if (pixelBuffer[0] < minDepth && pixelBuffer[0] > 0) {
          minDepth = pixelBuffer[0];
        }
      }
    }
    return minDepth;
  }
  private createAnnotationElement(
    position: THREE.Vector3,
    label: string,
    dimensions?: DimensionSet,
  ) {
    const container = document.createElement("div");
    container.className = "annotation-container";

    // Create the "Pin" (the dot)
    const pin = document.createElement("div");
    pin.className = "annotation-pin";

    // Create the "Card" (the info)
    const card = document.createElement("div");
    card.className = "annotation-card";
    const title = document.createElement("h3");
    title.textContent = label;
    if (dimensions) {
      const dimensionsLine = document.createElement("h3");
      dimensionsLine.textContent = `${this.formatMeters(dimensions.width)} x ${this.formatMeters(dimensions.height)} x ${this.formatMeters(dimensions.depth)}`;
      card.appendChild(dimensionsLine);
    }
    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "Close";
    card.appendChild(title);
    // card.appendChild(closeBtn);
    card.style.display = "none"; // Hidden by default

    // Interaction: Toggle card on pin click
    pin.onclick = (e) => {
      e.stopPropagation();
      card.style.display = card.style.display === "none" ? "block" : "none";
    };

    closeBtn.addEventListener("click", () => {
      card.style.display = "none";
    });

    container.appendChild(pin);
    container.appendChild(card);
    document.body.appendChild(container);

    this.annotations.push({ element: container, position });
  }

  private formatMeters(value: number): string {
    return `${value.toFixed(2)}m`;
  }

  private sanitizeDetectionBox(
    box: AnnotationDetection["box"],
  ): AnnotationDetection["box"] | null {
    if (!Array.isArray(box) || box.length !== 4) return null;
    const clamped = box.map((value) =>
      Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0,
    ) as AnnotationDetection["box"];
    const [xmin, ymin, xmax, ymax] = clamped;
    const width = xmax - xmin;
    const height = ymax - ymin;
    if (width < 0.02 || height < 0.02) {
      return null;
    }
    return clamped;
  }

  private sampleCandidatesFromBox(
    box: AnnotationDetection["box"],
    // gridSize = 10,
  ): CandidatePoint[] {
    const [xmin, ymin, xmax, ymax] = box;
    const candidates: CandidatePoint[] = [];
    // Adaptive sampling: scale grid resolution based on the 2D bounding box area
    const width = xmax - xmin;
    const height = ymax - ymin;
    const area = width * height;

    const minGridSize = 6;
    const maxGridSize = 25;
    const gridSize = Math.max(
      minGridSize,
      Math.min(
        maxGridSize,
        Math.round(minGridSize + (maxGridSize - minGridSize) * Math.sqrt(area)),
      ),
    );

    console.log(
      `[Adaptive Sampling] Box Area: ${area.toFixed(4)}, Selected Grid Size: ${gridSize}x${gridSize} (${gridSize * gridSize} rays)`,
    );
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const u = (col + 0.5) / gridSize;
        const v = (row + 0.5) / gridSize;
        const sampleX = xmin + u * (xmax - xmin);
        const sampleY = ymin + v * (ymax - ymin);
        const worldPosRay = this.getAnnotationPosition(sampleX, sampleY);

        // Depth Kernel Integration (Policy: Depth valid > Raycast > Drop)
        const px = sampleX * this.renderer.domElement.width;
        const py = sampleY * this.renderer.domElement.height;
        const depth = this.getDepthKernel(px, py);

        const hasValidDepth = depth < 1.0 && depth > 0;
        const depthNdc = hasValidDepth ? depth * 2 - 1 : Number.NaN;
        const depthPos = hasValidDepth
          ? new THREE.Vector3(sampleX * 2 - 1, -(sampleY * 2 - 1), depthNdc).unproject(
            this.camera,
          )
          : null;
        let finalPos: THREE.Vector3 | null = null;
        let flags = 0;

        // 1. Depth valid
        if (hasValidDepth && depthPos) {
          finalPos = depthPos;
          flags |= CandidateFlags.DepthValid | CandidateFlags.UsedDepthPosition;
        } else if (worldPosRay) {
          // 2. Depth invalid but raycast exists
          finalPos = worldPosRay;
          flags |= CandidateFlags.UsedRaycastPosition;
        }

        if (worldPosRay) flags |= CandidateFlags.RaycastValid;

        const rayDistance = worldPosRay
          ? this.camera.position.distanceTo(worldPosRay)
          : Number.NaN;
        const depthResidual =
          depthPos && worldPosRay
            ? depthPos.distanceTo(worldPosRay)
            : Number.NaN;
        if (Number.isFinite(depthResidual)) {
          flags |= CandidateFlags.DepthResidualValid;
        }

        if (finalPos) {
          candidates.push({
            position: [finalPos.x, finalPos.y, finalPos.z],
            depthNdc,
            sampleUv: [sampleX, sampleY],
            rayDistance,
            depthResidual,
            flags,
            confidence: 1.0,
          });
        }
      }
    }

    return candidates;
  }

  private samplePointsFromBox(
    box: AnnotationDetection["box"],
    // gridSize = 10,
  ): THREE.Vector3[] {
    const candidates = this.sampleCandidatesFromBox(box);
    return candidates.map(
      (candidate) =>
        new THREE.Vector3(
          candidate.position[0],
          candidate.position[1],
          candidate.position[2],
        ),
    );
  }

  private renderMeasurementBox(points: THREE.Vector3[]) {
    if (this.activeBoxHelper) {
      this.scene.remove(this.activeBoxHelper);
      this.activeBoxHelper = null;
    }

    if (points.length === 0) return;

    const box = new THREE.Box3().setFromPoints(points);
    const helper = new THREE.Box3Helper(box, 0x76a8ff);
    this.scene.add(helper);
    this.activeBoxHelper = helper;
  }

  private annotateFromDetection(
    detection: AnnotationDetection,
    clickWorldPosAtClick: THREE.Vector3 | null,
  ) {
    const sanitizedBox = this.sanitizeDetectionBox(detection.box);
    if (!sanitizedBox) {
      console.warn(
        "Discarding invalid or tiny Gemini bounding box.",
        detection.box,
      );
      return;
    }

    const sampledPoints = this.samplePointsFromBox(sanitizedBox);
    const measured = this.geometricContext.registerAndMeasureObject(
      detection.label,
      sampledPoints,
      { eps: 0.3, minPts: 10 },
    );

    if (measured) {
      this.renderMeasurementBox(measured.points);
      this.createAnnotationElement(
        measured.centroid.clone(),
        detection.label,
        measured.dimensions,
      );
      return;
    }

    if (clickWorldPosAtClick) {
      this.createAnnotationElement(
        clickWorldPosAtClick.clone(),
        detection.label,
      );
      return;
    }

    this.annotateDetectedObject(sanitizedBox, detection.label);
  }

  private annotateDetectedObject(
    box: AnnotationDetection["box"],
    label: string,
  ) {
    const [xmin, ymin, xmax, ymax] = box;
    const centerX = (xmin + xmax) / 2;
    const centerY = (ymin + ymax) / 2;

    const worldPos = this.getAnnotationPosition(centerX, centerY);
    if (worldPos) {
      this.createAnnotationElement(worldPos, label);
    } else {
      console.warn(`Lifting failed for ${label}`);
    }
  }

  private async captureSnapshot(): Promise<string> {
    // 1. Force a render to ensure scene is up to date
    this.renderer.render(this.scene, this.camera);

    // 2. Wait for GPU buffer sync
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // 3. Optional: Force GPU finish if necessary (very safe, prevents black screens)
    this.renderer.getContext().finish();

    return this.renderer.domElement.toDataURL("image/jpeg", 0.7);
  }

  private closeDiagnosisPanel() {
    this.diagnosisVersion++;
    this.clearSelection();
    this.diagnosisPanel?.remove();
    this.diagnosisPanel = null;
  }

  private clearSelection() {
    disposeHighlight(this.selectionHighlight);
    this.selectionHighlight = null;
    this.selection = null;
  }

  /** Selects the Gaussians responsible for a region as seen from the diagnosis camera. */
  private selectRegion(region: Region, viewProjection: THREE.Matrix4): string {
    this.clearSelection();
    const store = this.gaussianStore;
    if (!store || !this.currentSplat) return "Selection needs an editable binary PLY scene.";
    this.currentSplat.updateMatrixWorld(true);
    this.worldAttributes ??= buildWorldAttributes(store, this.currentSplat.matrixWorld);
    const started = performance.now();
    const { result, stats } = liftRegion({
      ...this.worldAttributes, skip: store.isPruned, viewProjection: viewProjection.elements,
      mask: region.pixels, width: region.width, height: region.height, bbox: region.bbox, class: region.class,
    });
    console.info(`Lifted ${region.class} in ${(performance.now() - started).toFixed(0)} ms`, stats);
    if (!result.indices.length) return "No visible Gaussians project into this region.";
    this.selection = result;
    this.selectionHighlight = createHighlight(this.worldAttributes.centers, result.indices, result.detached);
    this.scene.add(this.selectionHighlight);
    const notice = rectificationNotice(region.class);
    return `${result.indices.length.toLocaleString()} Gaussians selected (${stats.detached.toLocaleString()} detached, shown red).${notice ? ` ${notice}` : ""}`;
  }

  private applySelection(): string {
    const store = this.gaussianStore;
    const selection = this.selection;
    if (!store || !this.currentSplat || !selection) return "Nothing selected.";
    const notice = rectificationNotice(selection.class);
    if (notice) return notice;
    if (!editableSplats(this.currentSplat, store)) {
      return "Renderer splat order does not match the PLY, so the edit cannot be previewed and was not applied.";
    }
    const records = this.rectificationHistory.apply(store, selection);
    this.syncRecords(records);
    this.clearSelection();
    if (!records.length) return "The rectification rules produced no changes for this selection.";
    const counts = records.map(record => `${record.property === "$pruned" ? "pruned" : record.property}: ${record.indices.length}`);
    return `Applied (${counts.join(", ")}).`;
  }

  /** Pushes store edits for the touched Gaussians into the renderer and the lifting cache. */
  private syncRecords(records: EditRecord[] | undefined) {
    const store = this.gaussianStore;
    if (!store || !this.currentSplat || !records?.length) return;
    const splats = editableSplats(this.currentSplat, store);
    if (!splats) return;
    const touched = new Set<number>();
    records.forEach(record => record.indices.forEach(index => touched.add(index)));
    syncSplats(splats, store, touched);
    const attributes = this.worldAttributes;
    if (!attributes) return;
    const scaleFactor = this.currentSplat.matrixWorld.getMaxScaleOnAxis();
    touched.forEach(i => {
      attributes.alphas[i] = 1 / (1 + Math.exp(-store.get(i, "opacity")));
      attributes.radii[i] = Math.exp(Math.max(store.get(i, "scale_0"), store.get(i, "scale_1"), store.get(i, "scale_2"))) * scaleFactor;
    });
  }

  private renderDiagnosisPanel(regions: Region[], viewProjection: THREE.Matrix4) {
    this.clearSelection();
    this.diagnosisPanel?.remove();
    const panel = document.createElement("section");
    panel.className = "diagnosis-panel";
    const heading = document.createElement("strong");
    heading.textContent = "Flaw regions";
    const status = document.createElement("span");
    status.className = "diagnosis-status";
    const editable = Boolean(this.gaussianStore);
    status.textContent = `${regions.length} detected component(s).${editable ? " Select a region to highlight its Gaussians." : " Editing unavailable: scene is not a binary PLY."}`;

    const button = (label: string, onClick: () => void) => {
      const el = document.createElement("button");
      el.textContent = label;
      el.onclick = onClick;
      return el;
    };
    const apply = button("Apply", () => { status.textContent = this.applySelection(); refresh(); });
    const undo = button("Undo", () => {
      this.syncRecords(this.gaussianStore ? this.rectificationHistory.undo(this.gaussianStore) : undefined);
      status.textContent = "Undone.";
      refresh();
    });
    const redo = button("Redo", () => {
      this.syncRecords(this.gaussianStore ? this.rectificationHistory.redo(this.gaussianStore) : undefined);
      status.textContent = "Redone.";
      refresh();
    });
    const exportPly = button("Export PLY", () => {
      if (this.gaussianStore) downloadRectifiedPly(this.gaussianStore, this.sceneName);
    });
    const close = button("Close", () => this.closeDiagnosisPanel());
    const refresh = () => {
      apply.disabled = !this.selection || Boolean(rectificationNotice(this.selection.class));
      undo.disabled = !editable || !this.rectificationHistory.canUndo;
      redo.disabled = !editable || !this.rectificationHistory.canRedo;
      exportPly.disabled = !this.gaussianStore?.hasEdits;
    };

    panel.append(heading, status);
    regions.forEach((region) => {
      const row = document.createElement("div");
      row.className = "diagnosis-row";
      const label = document.createElement("span");
      label.textContent = `${region.class} (${region.confidence.toFixed(2)})`;
      const select = button("Select", () => { status.textContent = this.selectRegion(region, viewProjection); refresh(); });
      select.disabled = !editable;
      row.append(label, select);
      panel.appendChild(row);
    });
    const actions = document.createElement("div");
    actions.className = "diagnosis-actions";
    actions.append(apply, undo, redo, exportPly, close);
    panel.appendChild(actions);
    refresh();
    document.body.appendChild(panel);
    this.diagnosisPanel = panel;
  }

  private async requestDiagnosisFromGemini(clickX: number, clickY: number) {
    if (this.diagnosisPending) return;
    this.diagnosisPending = true;
    const version = ++this.diagnosisVersion;
    try {
      this.setAnnotationLoading(true);
      const dataUrl = await this.captureSnapshot();
      // Lifting must use the camera that produced the snapshot, not wherever the user orbits next.
      const viewProjection = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      const response = await diagnose(buildDiagnoseEndpoint(API_BASE_URL), dataUrl, { x: clickX, y: clickY }, BYPASS_TUNNEL_REMINDER);
      const regions = await decodeRegions(response, this.renderer.domElement.width, this.renderer.domElement.height);
      if (version === this.diagnosisVersion && this.activeTool === "diagnose") this.renderDiagnosisPanel(regions, viewProjection);
    } catch (error) {
      if (version === this.diagnosisVersion) {
        console.error("Diagnosis error:", error);
        window.alert(`Diagnosis failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.diagnosisPending = false;
      this.setAnnotationLoading(false);
    }
  }
  // public async requestAnnotationFromGemini(box: number[]) {
  //     try {
  //         // const dataUrl = this.renderer.domElement.toDataURL("image/jpeg", 0.7);
  //         const dataUrl = await this.captureSnapshot();
  //         const headers: Record<string, string> = { "Content-Type": "application/json" };

  //         if (BYPASS_TUNNEL_REMINDER) {
  //           headers["bypass-tunnel-reminder"] = "true";
  //         }

  //         const endpoint = buildAnnotateEndpoint(API_BASE_URL);

  //         const response = await fetch(endpoint, {
  //             method: "POST",
  //             headers,
  //             body: JSON.stringify({ image: dataUrl, userBox: box }),
  //         });

  //         const data = await response.json();

  //         if (data.objects && Array.isArray(data.objects)) {
  //             data.objects.forEach((item: any) => {
  //                 // item.label is now whatever the AI decided it was!
  //                 console.log(`Annotating detected object: ${item.label} at box ${item.box}`);
  //                 const label = item.label === "objects" ? "Detected Item" : item.label;
  //                 const description = item.description === "objects" ? "Detected Item" : item.description;
  //                 this.annotateDetectedObject(item.box, label, description);
  //             });
  //         }
  //     } catch (err) {
  //         console.error("Annotation Error:", err);
  //     }
  //   }
  public async requestAnnotationFromGemini(
    clickX: number,
    clickY: number,
    clickWorldPosAtClick: THREE.Vector3 | null,
  ) {
    try {
      this.setAnnotationLoading(true);
      const dataUrl = await this.captureSnapshot();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (BYPASS_TUNNEL_REMINDER) headers["bypass-tunnel-reminder"] = "true";

      const response = await fetch(buildAnnotateEndpoint(API_BASE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: dataUrl,
          clickX: clickX,
          clickY: clickY,
        }),
      });

      if (!response.ok) throw new Error("Server error");
      const data = await response.json();
      this.disableAnnotationToolButton();
      const detection: AnnotationDetection | null =
        data && typeof data.label === "string" && Array.isArray(data.box)
          ? data
          : Array.isArray(data)
            ? (data[0] ?? null)
            : Array.isArray(data?.objects)
              ? (data.objects[0] ?? null)
              : null;

      if (!detection?.label || !Array.isArray(detection.box)) {
        console.warn(
          "Expected single detection payload with label and box.",
          data,
        );
        return;
      }

      this.annotateFromDetection(detection, clickWorldPosAtClick);
    } catch (err) {
      console.error("Museum Mode Error:", err);
    } finally {
      this.setAnnotationLoading(false);
    }
  }
}

// Create singleton instance
export const viewer = new SplatViewer();

// Export loadWorld for compatibility with main.ts
export async function loadWorld(url: string) {
  return viewer.loadWorld(url);
}

// Initial load
// const initialURL = "/Apartment.sog";
const initialURL = "/Apartment.ply";
void loadWorld(initialURL).catch((error) => console.error("Initial scene load failed:", error));
