import * as THREE from "three";
import {
  SparkControls,
  SparkRenderer,
  SplatMesh,
  dyno,
} from "@sparkjsdev/spark";
import { setupSplatModifier } from "./utils/utils";
import {
  getMobileInput,
  getMobileLook,
  initMobileControls,
  isMobileDevice,
} from "./utils/mobileJoystick";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

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
    this.setupSelectionBox();
    this.startAnimationLoop();
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

  private setupSelectionBox() {
    this.renderer.domElement.addEventListener("mousedown", (e) => {
      if (!this.isSelecting) return;

      // Disable Spark camera input while selecting
      this.controls.fpsMovement.enable = false;
      this.controls.pointerControls.enable = false;

      this.startPoint = { x: e.clientX, y: e.clientY };

      this.selectionBox = document.createElement("div");
      this.selectionBox.style.position = "absolute";
      this.selectionBox.style.border = "2px dashed #00ff00";
      this.selectionBox.style.backgroundColor = "rgba(0, 255, 0, 0.1)";
      this.selectionBox.style.zIndex = "2000";
      document.body.appendChild(this.selectionBox);
    });

    this.renderer.domElement.addEventListener("mousemove", (e) => {
      if (!this.isSelecting || !this.startPoint || !this.selectionBox) return;

      const width = e.clientX - this.startPoint.x;
      const height = e.clientY - this.startPoint.y;

      this.selectionBox.style.left = `${Math.min(e.clientX, this.startPoint.x)}px`;
      this.selectionBox.style.top = `${Math.min(e.clientY, this.startPoint.y)}px`;
      this.selectionBox.style.width = `${Math.abs(width)}px`;
      this.selectionBox.style.height = `${Math.abs(height)}px`;
    });

    this.renderer.domElement.addEventListener("mouseup", (e) => {
      if (!this.isSelecting || !this.startPoint || !this.selectionBox) return;

      this.controls.fpsMovement.enable = true;
      this.controls.pointerControls.enable = true; // Re-enable movement

      const rect = this.selectionBox.getBoundingClientRect();
      const canvasRect = this.renderer.domElement.getBoundingClientRect();

      const box = [
        (rect.top - canvasRect.top) / canvasRect.height,
        (rect.left - canvasRect.left) / canvasRect.width,
        (rect.bottom - canvasRect.top) / canvasRect.height,
        (rect.right - canvasRect.left) / canvasRect.width,
      ];

      this.selectionBox.remove();
      this.selectionBox = null;
      this.startPoint = null;

      // Optionally auto-disable tool after selection
      this.isSelecting = false;
      document
        .getElementById("annotationToolButton")
        ?.classList.remove("active");

      this.requestAnnotationFromGemini(box);
    });
  }
  // private setupAnnotationUI() {
  //     // Button toggle
  //     const btn = document.getElementById('annotationToolButton');
  //     if (btn) {
  //         btn.addEventListener('click', () => {
  //             btn.classList.toggle('active');
  //         });
  //     }
  //     // if (btn) {
  //     //     btn.addEventListener("click", async () => {
  //     //     // statusText.innerText = "Asking Gemini for annotation...";
  //     //     // btn.disabled = true;
  //     //     try {
  //     //         await this.requestAnnotationFromGemini();
  //     //         // statusText.innerText = "Annotation added";
  //     //     } catch (err: any) {
  //     //         console.error(err);
  //     //         // statusText.innerText = `Gemini error: ${
  //     //         // err?.message ?? "unknown error"
  //     //         // }`;
  //     //     }
  //     //     });
  //     // }

  //     // Canvas click for placing annotations when active
  //     this.renderer.domElement.addEventListener('click', (ev) => {
  //         const btnActive = btn?.classList.contains('active');
  //         if (!btnActive) return;

  //         const rect = this.renderer.domElement.getBoundingClientRect();
  //         const x = (ev.clientX - rect.left) / rect.width;
  //         const y = (ev.clientY - rect.top) / rect.height;
  //         this.requestAnnotationFromGemini(x, y);
  //         // const pos = this.getAnnotationPosition(x, y);
  //         // if (pos) {
  //         //     const label = prompt('Annotation label:', 'Object');
  //         //     if (label) this.createAnnotationElement(pos, label);
  //         // }
  //     });
  // }
  private setupAnnotationUI() {
    const btn = document.getElementById("annotationToolButton");
    if (btn) {
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        // FIX: Toggle the state
        this.isSelecting = btn.classList.contains("active");
      });
    }
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
  private createAnnotationElement(position: THREE.Vector3, label: string) {
    const div = document.createElement("div");
    div.className = "annotation-label";
    div.innerText = label;
    div.style.position = "absolute";
    div.style.zIndex = "1000"; // Ensure it's on top of canvas
    div.style.pointerEvents = "none"; // So clicks pass through
    div.style.backgroundColor = "rgba(0,0,0,0.6)";
    div.style.color = "white";
    div.style.padding = "4px 8px";
    div.style.borderRadius = "4px";
    document.body.appendChild(div);

    this.annotations.push({ element: div, position });
  }

  private annotateDetectedObject(box: number[], label: string) {
    const [ymin, xmin, ymax, xmax] = box;
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
public async requestAnnotationFromGemini(box: number[]) {
    try {
        // const dataUrl = this.renderer.domElement.toDataURL("image/jpeg", 0.7);
        const dataUrl = await this.captureSnapshot();

        const response = await fetch("http://localhost:3000/api/annotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: dataUrl, userBox: box }),
        });

        const data = await response.json();
        
        if (data.objects && Array.isArray(data.objects)) {
            data.objects.forEach((item: any) => {
                // item.label is now whatever the AI decided it was!
                console.log(`Annotating detected object: ${item.label} at box ${item.box}`);
                const label = item.label === "objects" ? "Detected Item" : item.label;
                this.annotateDetectedObject(item.box, label);
            });
        }
    } catch (err) {
        console.error("Annotation Error:", err);
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
const initialURL = "/BiltmoreGaussianSplat.ply";
// const initialURL = "/BiltmoreGaussianSplat.sog";
loadWorld(initialURL);
