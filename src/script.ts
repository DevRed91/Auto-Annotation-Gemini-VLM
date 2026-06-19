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
// import { OrbitControls } from "three/examples/jsm/Addons.js";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ||
  "/api";
const BYPASS_TUNNEL_REMINDER =
  (import.meta.env.VITE_BYPASS_TUNNEL_REMINDER as string | undefined) === "true";

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

export class SplatViewer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private spark: SparkRenderer;
  private controls: SparkControls;
  private currentSplat: SplatMesh | null = null;
  private desiredCameraHeight = 0.15;
  private isMobile: boolean = isMobileDevice();
  private cameraRig = new THREE.Group();
  private animateT = dyno.dynoFloat(0);
  private baseTime = 0;
  private splatLoaded = false;
  private annotations: { element: HTMLElement; position: THREE.Vector3 }[] = [];
  private selectionBox: HTMLElement | null = null;
  private startPoint: { x: number; y: number } | null = null;
  private isSelecting = false;
  private annotationLoadingEl: HTMLElement | null = null;
  private annotationToolButton: HTMLButtonElement | null = null;
  private readonly geometricContext = new GeometricContextManager();
  private activeBoxHelper: THREE.Box3Helper | null = null;

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

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(this.renderer.domElement);
    this.controls = new SparkControls({ canvas: this.renderer.domElement });

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.setMobileControls();
    this.setupEventListeners();
    this.setupAnnotationUI();
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
  }

  private startAnimationLoop() {
    let lastTime = performance.now();
    this.renderer.setAnimationLoop((time) => {
      this.controls.update(this.cameraRig);
      this.camera.updateMatrixWorld(); 
      // this.lockCameraHeightToGround();
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
      this.renderer.render(this.scene, this.camera);
    });
  }

  private setupClickInteraction() {
    this.renderer.domElement.addEventListener("click", (e) => {
      // Only trigger if a specific tool is active (optional)
      if (!this.isSelecting) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const clickWorldPos = this.getAnnotationPosition(x, y);

      console.log(`User clicked at: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      
      // Trigger the new coordinate-based request
      this.requestAnnotationFromGemini(x, y, clickWorldPos);
    });
  }
  private setupAnnotationUI() {
    const btn = document.getElementById("annotationToolButton");
    if (btn) {
      this.annotationToolButton = btn as HTMLButtonElement;
      btn.addEventListener("click", () => {
        if ((btn as HTMLButtonElement).disabled) return;
        btn.classList.toggle("active");
        // FIX: Toggle the state
        this.isSelecting = btn.classList.contains("active");
      });
    }
  }

  private disableAnnotationToolButton() {
    if (!this.annotationToolButton) return;
    this.annotationToolButton.disabled = true;
    this.annotationToolButton.classList.toggle("disabled", true);
    this.isSelecting = false;
  }
  private updateAnnotationLabels() {
    this.annotations.forEach((ann) => {
      // Check if element exists
      if (!ann.element) return;

      // Project 3D point to NDC
      const pos = ann.position.clone().project(this.camera);

      // Hide if behind camera (pos.z > 1) or out of frustum
      if (pos.z > 1) {
        ann.element.style.display = "none";
      } else {
        ann.element.style.display = "block";
        // Convert NDC (-1 to 1) to screen pixels
        const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-pos.y * 0.5 + 0.5) * window.innerHeight;
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
    if (this.currentSplat) {
      this.scene.remove(this.currentSplat);
      this.currentSplat = null;
    }
    const splat = new SplatMesh({ url });
    splat.quaternion.set(1, 0, 0, 0);
    splat.position.set(0, -1.5, 0);
    this.currentSplat = splat;
    this.scene.add(this.currentSplat);
    this.splatLoaded = true;

    // setupSplatModifier(this.currentSplat);
    this.addGroundPlane();
  }
  private lockCameraHeightToGround() {
    // Game-style: keep the rig at a fixed height above the world origin (Y=0 ground).
    // The camera sits at local Y=0 inside the rig, so the rig's Y IS the eye height.
    this.cameraRig.position.y = this.desiredCameraHeight;
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
            const px = Math.max(0, Math.min(this.renderer.domElement.width - 1, x + i));
            const py = Math.max(0, Math.min(this.renderer.domElement.height - 1, y + j));
            
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
    const container = document.createElement('div');
    container.className = 'annotation-container';
    
    // Create the "Pin" (the dot)
    const pin = document.createElement('div');
    pin.className = 'annotation-pin';
    
    // Create the "Card" (the info)
    const card = document.createElement('div');
    card.className = 'annotation-card';
    const title = document.createElement("h3");
    title.textContent = label;
    if (dimensions) {
      const dimensionsLine = document.createElement("p");
      dimensionsLine.textContent = `${this.formatMeters(dimensions.width)} x ${this.formatMeters(dimensions.height)} x ${this.formatMeters(dimensions.depth)}`;
      card.appendChild(dimensionsLine);
    }
    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "Close";
    card.appendChild(title);
    card.appendChild(closeBtn);
    card.style.display = 'none'; // Hidden by default

    // Interaction: Toggle card on pin click
    pin.onclick = (e) => {
        e.stopPropagation();
        card.style.display = card.style.display === 'none' ? 'block' : 'none';
    };

    closeBtn.addEventListener('click', () => {
        card.style.display = 'none';
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

  private samplePointsFromBox(
    box: AnnotationDetection["box"],
    gridSize = 10,
  ): THREE.Vector3[] {
    const [xmin, ymin, xmax, ymax] = box;
    const points: THREE.Vector3[] = [];

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const u = (col + 0.5) / gridSize;
        const v = (row + 0.5) / gridSize;
        const sampleX = xmin + u * (xmax - xmin);
        const sampleY = ymin + v * (ymax - ymin);
        const worldPos = this.getAnnotationPosition(sampleX, sampleY);
        if (worldPos) points.push(worldPos);
      }
    }

    return points;
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
      console.warn("Discarding invalid or tiny Gemini bounding box.", detection.box);
      return;
    }

    const sampledPoints = this.samplePointsFromBox(sanitizedBox, 10);
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
      this.createAnnotationElement(clickWorldPosAtClick.clone(), detection.label);
      return;
    }

    this.annotateDetectedObject(sanitizedBox, detection.label);
  }

  private annotateDetectedObject(box: AnnotationDetection["box"], label: string) {
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
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    // 3. Optional: Force GPU finish if necessary (very safe, prevents black screens)
    this.renderer.getContext().finish(); 
    
    return this.renderer.domElement.toDataURL("image/jpeg", 0.7);
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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (BYPASS_TUNNEL_REMINDER) headers["bypass-tunnel-reminder"] = "true";

      const response = await fetch(buildAnnotateEndpoint(API_BASE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({ 
          image: dataUrl, 
          clickX: clickX, 
          clickY: clickY 
        }),
      });

      if (!response.ok) throw new Error("Server error");
      const data = await response.json();
      this.disableAnnotationToolButton();
      const detection: AnnotationDetection | null =
        data && typeof data.label === "string" && Array.isArray(data.box)
          ? data
          : Array.isArray(data)
            ? data[0] ?? null
            : Array.isArray(data?.objects)
              ? data.objects[0] ?? null
              : null;

      if (!detection?.label || !Array.isArray(detection.box)) {
        console.warn("Expected single detection payload with label and box.", data);
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
const initialURL = "/Apartment.sog";
// const initialURL = "/BiltmoreGaussianSplat.sog";
loadWorld(initialURL);
