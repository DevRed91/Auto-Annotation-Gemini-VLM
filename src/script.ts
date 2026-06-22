/// <reference types="vite/client" />

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

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || "/api";

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
  private annotations: { element: HTMLElement; position: THREE.Vector3; id?: string }[] = [];
  private isSelecting = false;
  private annotationLoadingEl: HTMLElement | null = null;
  private annotationToolButton: HTMLButtonElement | null = null;
  private readonly geometricContext = new GeometricContextManager();
  private activeBoxHelper: THREE.Box3Helper | null = null;
  private metadataDB: any = null;

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
    this.setMobileControls();
    this.setupEventListeners();
    this.setupAnnotationUI();
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

  private async loadMetadata() {
    if (!this.metadataDB) {
      const response = await fetch("/metadata.json");
      this.metadataDB = await response.json();
    }
  }

  private setupAnnotationUI() {
    const btn = document.getElementById("annotationToolButton");
    if (btn) {
      this.annotationToolButton = btn as HTMLButtonElement;
      btn.addEventListener("click", () => {
        if ((btn as HTMLButtonElement).disabled) return;
        btn.classList.toggle("active");
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
      if (!ann.element) return;

      const pos = ann.position.clone().project(this.camera);

      if (pos.z > 1) {
        ann.element.style.display = "none";
      } else {
        ann.element.style.display = "block";
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
      move.y = 0;
      this.cameraRig.position.add(move);
    }
  }

  private setMobileControls() {
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
    plane.rotation.x = -Math.PI / 2;
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

    this.addGroundPlane();
  }

  private getDepthKernel(x: number, y: number): number {
    const gl = this.renderer.getContext();
    const kernelSize = 2;
    let minDepth = 1.0;
    const pixelBuffer = new Float32Array(1);
    const canvasWidth = this.renderer.domElement.width;
    const canvasHeight = this.renderer.domElement.height;

    for (let i = -kernelSize; i <= kernelSize; i++) {
      for (let j = -kernelSize; j <= kernelSize; j++) {
        const px = Math.max(0, Math.min(canvasWidth - 1, x + i));
        const py = Math.max(0, Math.min(canvasHeight - 1, y + j));

        const glY = canvasHeight - py;

        gl.readPixels(px, glY, 1, 1, gl.DEPTH_COMPONENT, gl.FLOAT, pixelBuffer);

        if (pixelBuffer[0] < minDepth && pixelBuffer[0] > 0) {
          minDepth = pixelBuffer[0];
        }
      }
    }
    return minDepth;
  }

  private getAnnotationPosition(
    normalizedX: number,
    normalizedY: number,
  ): THREE.Vector3 | null {
    const canvasWidth = this.renderer.domElement.width;
    const canvasHeight = this.renderer.domElement.height;
    const px = Math.round(normalizedX * canvasWidth);
    const py = Math.round(normalizedY * canvasHeight);

    const depth = this.getDepthKernel(px, py);
    if (depth >= 0.999) {
      return null;
    }

    const ndcX = normalizedX * 2 - 1;
    const ndcY = -(normalizedY * 2 - 1);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    if (this.currentSplat) {
      const intersects: THREE.Intersection[] = [];
      this.currentSplat.raycast(raycaster, intersects);
      if (intersects.length > 0) {
        return intersects[0].point;
      }
    }
    return null;
  }

  private setupClickInteraction() {
    this.renderer.domElement.addEventListener(
      "click",
      async (event: MouseEvent) => {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;

        if (this.isSelecting) {
          await this.requestAnnotationFromGemini(undefined, x, y);
          return;
        }

        const ndcX = x * 2 - 1;
        const ndcY = -(y * 2 - 1);

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

        const intersects: THREE.Intersection[] = [];
        if (this.currentSplat) {
          this.currentSplat.raycast(raycaster, intersects);
        }

        if (intersects.length > 0) {
          const hitPoint = intersects[0].point;
          const matchedObject =
            this.geometricContext.resolveInstanceAtPoint(hitPoint);

          if (matchedObject) {
            const ann = this.annotations.find((a) => a.id === matchedObject.id);
            if (ann) {
              const card = ann.element.querySelector(
                ".annotation-card",
              ) as HTMLElement;
              if (card) {
                card.style.display =
                  card.style.display === "none" ? "block" : "none";
              }
            }
          } else {
            this.dismissActiveCards();
          }
        } else {
          this.dismissActiveCards();
        }
      },
    );
  }

  private dismissActiveCards() {
    this.annotations.forEach((ann) => {
      const card = ann.element.querySelector(
        ".annotation-card",
      ) as HTMLElement;
      if (card) {
        card.style.display = "none";
      }
    });
  }

  private renderAnnotation(
    worldPos: THREE.Vector3,
    label: string,
    description: string,
    dimensions: THREE.Vector3,
    id?: string,
  ) {
    this.annotations.forEach((ann) => {
      ann.element.remove();
    });
    this.annotations = [];

    const key = label.toLowerCase().trim();
    const meta = (this.metadataDB && this.metadataDB[key]) || {
      name: label,
      description: description || "No description available.",
      era: "Contemporary",
      material: "Modern Materials",
    };

    const formattedDimensions = `${dimensions.x.toFixed(2)}m x ${dimensions.y.toFixed(2)}m x ${dimensions.z.toFixed(2)}m`;

    const container = document.createElement("div");
    container.className = "annotation-container";
    container.style.position = "absolute";
    container.style.pointerEvents = "none";

    const pin = document.createElement("div");
    pin.className = "annotation-pin";
    pin.style.pointerEvents = "auto";

    const card = document.createElement("div");
    card.className = "annotation-card active";
    card.style.position = "absolute";
    card.style.zIndex = "2500";
    card.style.pointerEvents = "auto";
    card.style.display = "none";

    card.innerHTML = `
      <div class="card-header">
        <h3>${meta.name || label}</h3>
      </div>
      <div class="card-specs">
        <p><strong>Era:</strong> ${meta.era || "Unknown Era"}</p>
        <p><strong>Material:</strong> ${meta.material || "Unknown Material"}</p>
        <p><strong>Dimensions:</strong> ${meta.dimensions || formattedDimensions}</p>
      </div>
      <p class="card-description">${meta.description || description}</p>
      <button class="close-btn">Dismiss</button>
    `;

    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      card.style.display = card.style.display === "none" ? "block" : "none";
    });

    const closeBtn = card.querySelector(".close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        card.style.display = "none";
      });
    }

    container.appendChild(pin);
    container.appendChild(card);
    document.body.appendChild(container);

    this.annotations.push({ element: container, position: worldPos, id });
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

  private async executeAnnotationPipeline(
    box: number[],
    label: string,
    description: string,
  ) {
    const sampledPoints: THREE.Vector3[] = [];
    const gridSize = 10;
    const [xmin, ymin, xmax, ymax] = box;

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const u = (col + 0.5) / gridSize;
        const v = (row + 0.5) / gridSize;
        const sampleX = xmin + u * (xmax - xmin);
        const sampleY = ymin + v * (ymax - ymin);
        const worldPos = this.getAnnotationPosition(sampleX, sampleY);
        if (worldPos) {
          sampledPoints.push(worldPos);
        }
      }
    }

    const measured = this.geometricContext.registerAndMeasureObject(
      label,
      sampledPoints,
      { eps: 0.3, minPts: 10 },
    );

    if (measured) {
      this.geometricContext.registerObjectPoints(label, measured.points);

      const matchedInstance =
        this.geometricContext.resolveInstanceAtPoint(measured.centroid);
      const uniqueId = matchedInstance ? matchedInstance.id : undefined;

      this.renderMeasurementBox(measured.points);

      const dimensionsVec = new THREE.Vector3(
        measured.dimensions.width,
        measured.dimensions.height,
        measured.dimensions.depth,
      );

      this.renderAnnotation(
        measured.centroid,
        label,
        description,
        dimensionsVec,
        uniqueId,
      );
    } else {
      console.warn("Measurement failed for pipeline:", label);
    }
  }

  private async captureSnapshot(): Promise<string> {
    this.renderer.render(this.scene, this.camera);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    this.renderer.getContext().finish();
    return this.renderer.domElement.toDataURL("image/jpeg", 0.7);
  }

  public async requestAnnotationFromGemini(
    box?: number[],
    clickX?: number,
    clickY?: number,
  ) {
    try {
      await this.loadMetadata();
      this.setAnnotationLoading(true);

      const dataUrl = await this.captureSnapshot();
      const headers = {
        "Content-Type": "application/json",
        "bypass-tunnel-reminder": "true",
      };

      const endpoint = buildAnnotateEndpoint(API_BASE_URL);

      const requestBody: Record<string, any> = { image: dataUrl };
      if (box) {
        requestBody.userBox = box;
      } else if (clickX !== undefined && clickY !== undefined) {
        requestBody.clickX = clickX;
        requestBody.clickY = clickY;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) throw new Error("Server error");
      const item = await response.json();

      this.disableAnnotationToolButton();
      const label = item.label || "Detected Item";
      const description = item.description || "No description available.";
      const itemBox = item.box || box;
      if (itemBox) {
            this.executeAnnotationPipeline(itemBox, label, description);
          }
    } catch (err) {
      console.error("Museum Mode Error:", err);
    } finally {
      this.setAnnotationLoading(false);
    }
  }
}

export const viewer = new SplatViewer();

export async function loadWorld(url: string) {
  return viewer.loadWorld(url);
}

const initialURL = "/Apartment.sog";
loadWorld(initialURL);
