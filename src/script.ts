import * as THREE from "three";
import { io, Socket } from "socket.io-client";
import {
  SparkControls,
  SparkRenderer,
  SplatMesh,
  dyno,
} from "@sparkjsdev/spark";
import { injectHighlightDyno, updateHighlightDynoUniforms, dynoMaskActive } from "./shader";
import {
  getMobileInput,
  getMobileLook,
  initMobileControls,
  isMobileDevice,
} from "./utils/mobileJoystick";
import GeometricContextManager from "./GeometricContextManager/GeometricContextManager";
import { SemanticToken } from "./utils/types";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || "/api";
const SOCKET_URL =
  (import.meta.env.VITE_SOCKET_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || "";
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

function buildSocketEndpoint(apiBaseUrl: string, socketUrl: string): string {
  if (socketUrl) return socketUrl;

  let normalized = apiBaseUrl.replace(/\/+$/, "");
  normalized = normalized.replace(/\/api\/annotate$/, "");
  normalized = normalized.replace(/\/annotate$/, "");
  normalized = normalized.replace(/\/api$/, "");

  if (normalized.startsWith("http")) return normalized;
  return window.location.origin;
}

interface AnnotationDetection {
  label: string;
  box: [number, number, number, number];
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
  private annotations: {
    element: HTMLElement;
    position: THREE.Vector3;
    descriptionEl: HTMLParagraphElement;
  }[] = [];
  private selectionBox: HTMLElement | null = null;
  private startPoint: { x: number; y: number } | null = null;
  private isSelecting = false;
  private socket: Socket | null = null;
  private pendingSocketAnchor: THREE.Vector3 | null = null;
  private latestMaskLabel: string | null = null;
  private capturedProjectionMatrix: THREE.Matrix4 | null = null;
  private capturedViewMatrix: THREE.Matrix4 | null = null;

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
    // this.setupSelectionBox();
    this.setupClickInteraction();
    this.startAnimationLoop();
    this.setupSocket();
  }

  private setupEventListeners() {
    window.addEventListener("resize", () => this.onWindowResize());
  }
  //   private refreshUIFromMemory() {
  //     // 1. Remove all current annotation elements from the DOM
  //     this.annotations.forEach(ann => ann.element.remove());
  //     this.annotations = [];

  //     // 2. Get the "Validated" objects from Global Trajectory Memory
  //     const activeObjects = this.geoContext.getActiveObjects();

  //     // 3. Re-create UI elements only for confirmed objects
  //     activeObjects.forEach(obj => {
  //         this.createAnnotationElement(obj.worldPos, obj.label);
  //     });
  // }
  private setupSocket() {
    const endpoint = buildSocketEndpoint(API_BASE_URL, SOCKET_URL);
    this.socket = io(endpoint);

    this.socket.on("connect", () => {
      console.log("Socket connected:", this.socket?.id);
    });

    this.socket.on("disconnect", (reason) => {
      console.warn("Socket disconnected:", reason);
    });

    this.socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);
    });

    // Listener 1: The Instant Glow (from YOLO)
    this.socket.on(
      "mask_ready",
      (data: { mask?: number[][]; label?: string }) => {
        console.log("YOLO Mask Received!");
        if (Array.isArray(data?.mask)) {
          this.latestMaskLabel =
            typeof data.label === "string" && data.label.trim()
              ? data.label.trim().toLowerCase()
              : null;
          this.updateGPUMask(data.mask);
        } else {
          this.latestMaskLabel = null;
          this.setMaskActive(false);
        }

        if (this.pendingSocketAnchor && data?.label) {
          this.processDetection(this.pendingSocketAnchor.clone(), data.label);
        }
      },
    );

    // Listener 2: The Deep Info (from Gemini)
    this.socket.on("description_ready", (data: { description?: string }) => {
      console.log("Gemini Info Received!");
      if (typeof data?.description === "string" && data.description.trim()) {
        this.updateLatestAnnotationDescription(data.description);
      }
      this.pendingSocketAnchor = null;
    });

    this.socket.on("error", (message: string) => {
      console.error("Realtime annotation error:", message);
      this.pendingSocketAnchor = null;
    });
  }

  private geoContext = new GeometricContextManager();
  private triggerDynoHighlightForLabel(label: string) {
    const normalizedLabel = label.trim().toLowerCase();
    if (!normalizedLabel || !this.maskTexture) {
      this.setMaskActive(false);
      return;
    }

    // If backend returned a label for the current mask, only activate when it matches.
    if (this.latestMaskLabel && this.latestMaskLabel !== normalizedLabel) {
      this.setMaskActive(false);
      return;
    }

    this.updateUniforms(this.maskTexture);
  }

  private processDetection(worldPos: THREE.Vector3, label: string) {
    // Create a generic Semantic Token
    const token: SemanticToken = {
      id: THREE.MathUtils.generateUUID(),
      label: label, // Use the dynamic label from Gemini
      worldPos: worldPos,
      confidence: 1.0,
      timestamp: Date.now(),
    };

    // The Manager handles the geometric logic regardless of label
    // this.geoContext.addToken(token);
    this.triggerDynoHighlightForLabel(label);
    this.createAnnotationElement(worldPos, label);

    // this.refreshUIFromMemory();
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

  private setupClickInteraction() {
    this.renderer.domElement.addEventListener("click", (e) => {
      if (!this.isSelecting) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      console.log(`User clicked at: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);

      // 1. Get 3D position
      const worldPos = this.getAnnotationPosition(x, y);

      // 2. Check Spatial Memory
      if (worldPos) {
        // const existing = this.geoContext.findExistingObject(worldPos);

        // if (existing) {
        //   console.log(`Spatial Memory: This is the ${existing.label}. Skipping API.`);
        //   return; // Exit early: Do not call the API
        // }

        // 3. If no existing object, proceed to request from Gemini
        // console.log("No existing object found, querying Gemini...");
        this.requestAnnotationFromGemini(x, y, worldPos);
      } else {
        console.warn("Click did not hit a valid surface (Depth = 1.0).");
      }
    });
  }
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
  private maskTexture: THREE.DataTexture | null = null;
  private static readonly EXPECTED_MASK_DIM = 128;

  private clearMaskTexture() {
    if (this.maskTexture) {
      this.maskTexture.dispose();
      this.maskTexture = null;
    }
    this.latestMaskLabel = null;
  }

  public updateGPUMask(maskArray: number[][]) {
    // Do not push mask uniforms until the splat pipeline has been initialized.
    if (!this.splatLoaded || !this.currentSplat) {
      this.clearMaskTexture();
      this.setMaskActive(false);
      return;
    }

    // 1. Guard Clause: Check if mask exists and has content
    if (!maskArray || maskArray.length === 0 || !maskArray[0]) {
      console.warn("YOLO returned an empty or invalid mask.");
      this.clearMaskTexture();
      this.setMaskActive(false);
      return;
    }

    // 2. Dynamic Dimension Detection
    const height = maskArray.length;
    const width = maskArray[0].length;
    if (height <= 0 || width <= 0) {
      console.warn("YOLO returned a zero-sized mask.");
      this.clearMaskTexture();
      this.setMaskActive(false);
      return;
    }

    if (
      width !== SplatViewer.EXPECTED_MASK_DIM ||
      height !== SplatViewer.EXPECTED_MASK_DIM
    ) {
      console.warn(
        `Invalid mask dimensions: ${width}x${height}. Expected ${SplatViewer.EXPECTED_MASK_DIM}x${SplatViewer.EXPECTED_MASK_DIM}.`,
      );
      this.clearMaskTexture();
      this.setMaskActive(false);
      return;
    }

    // 3. Safe Flattening Logic — 4 bytes per pixel to match THREE.RGBAFormat.
    // sampler2D on most GPU drivers requires RGBA data; .r in the shader still
    // reads the red channel correctly.
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const row = maskArray[y];
      // Check row integrity
      if (!Array.isArray(row) || row.length !== width) {
        console.warn("YOLO returned a non-rectangular mask.");
        this.clearMaskTexture();
        this.setMaskActive(false);
        return;
      }
      for (let x = 0; x < width; x++) {
        const value = row[x];
        if (!Number.isFinite(value)) {
          console.warn("YOLO returned a mask with non-numeric entries.");
          this.clearMaskTexture();
          this.setMaskActive(false);
          return;
        }
        // Write into all 4 channels so the sampler always reads consistently.
        const v = value > 0.5 ? 255 : 0;
        const i = (y * width + x) * 4;
        data[i] = v;     // R
        data[i + 1] = v; // G
        data[i + 2] = v; // B
        data[i + 3] = 255; // A — always opaque
      }
    }

    // 4. Texture Lifecycle Management
    // Dispose and recreate if dimensions changed to prevent GPU errors
    if (
      this.maskTexture &&
      (this.maskTexture.image.width !== width ||
        this.maskTexture.image.height !== height)
    ) {
      this.clearMaskTexture();
    }

    if (!this.maskTexture) {
      this.maskTexture = new THREE.DataTexture(
        data,
        width,
        height,
        THREE.RGBAFormat
      );
      this.maskTexture.minFilter = THREE.LinearFilter; // Smoothing
      this.maskTexture.magFilter = THREE.LinearFilter;
    } else {
      // Reuse buffer if dimensions match (Performant)
      (this.maskTexture.image.data as Uint8Array).set(data);
    }

    this.maskTexture.needsUpdate = true;

    // 5. Apply to Shader
    this.updateUniforms(this.maskTexture);
  }

  private setMaskActive(active: boolean) {
    // Dyno uniforms are reactive — updating the value propagates to the GPU automatically
    dynoMaskActive.value = active ? 1.0 : 0.0;
  }

  private updateUniforms(texture: THREE.DataTexture) {
    if (this.capturedProjectionMatrix && this.capturedViewMatrix) {
      updateHighlightDynoUniforms(
        this.capturedProjectionMatrix,
        this.capturedViewMatrix,
        texture,
        true
      );
    } else {
      // Never activate mask sampling before snapshot matrices are available.
      this.setMaskActive(false);
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
    this.clearMaskTexture();
    this.setMaskActive(false);

    const splat = new SplatMesh({ url });
    splat.quaternion.set(1, 0, 0, 0);
    splat.position.set(0, -1.5, 0);
    this.currentSplat = splat;

    // Inject the Dyno highlight modifier into the SplatMesh generator pipeline
    injectHighlightDyno(this.currentSplat);

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
  private createAnnotationElement(position: THREE.Vector3, label: string) {
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
    const description = document.createElement("p");
    description.textContent = "";
    description.style.display = "none";
    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "Close";
    card.appendChild(title);
    card.appendChild(description);
    card.appendChild(closeBtn);
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

    this.annotations.push({
      element: container,
      position,
      descriptionEl: description,
    });
  }

  private updateLatestAnnotationDescription(description: string) {
    const latest = this.annotations.at(-1);
    if (!latest) return;
    latest.descriptionEl.textContent = description;
    latest.descriptionEl.style.display = "block";
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
  public async captureSnapshot() {
    this.renderer.render(this.scene, this.camera);
    await new Promise((r) => requestAnimationFrame(r));
    this.renderer.getContext().finish();

    const projectionMatrix = this.camera.projectionMatrix.clone();
    const viewMatrix = this.camera.matrixWorldInverse.clone();

    this.capturedProjectionMatrix = projectionMatrix;
    this.capturedViewMatrix = viewMatrix;

    return {
      image: this.renderer.domElement.toDataURL("image/jpeg", 0.7),
      // CAPTURE MATRICES AT THIS INSTANT
      projectionMatrix,
      viewMatrix,
    };
  }
  /**
   * Validation guard for mask shape
   */
  private isValidMask(mask: any): mask is number[][] {
    return (
      Array.isArray(mask) &&
      mask.length === SplatViewer.EXPECTED_MASK_DIM &&
      mask.every(
        (row) =>
          Array.isArray(row) && row.length === SplatViewer.EXPECTED_MASK_DIM,
      )
    );
  }
  public async runSofaColdStart(timeoutMs: number = 5000) {
    console.log("Initializing hardened spatial mapping for: Sofa...");
    const scanAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const originalRotation = this.cameraRig.rotation.y;

    try {
      for (const angle of scanAngles) {
        this.cameraRig.rotation.y = angle;
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));

        const frameData = this.renderer.domElement.toDataURL("image/jpeg", 0.5);

        // 1. & 3. AbortController for timeout + Response validation
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(
            "http://localhost:8000/api/startup-scan-sofa",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: frameData }),
              signal: controller.signal,
            },
          );

          if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

          const data = await response.json();

          // Validate payload structure before iteration
          if (data && Array.isArray(data.sofaMasks)) {
            for (const mask of data.sofaMasks) {
              if (this.isValidMask(mask)) {
                const worldCoordinates = this.projectMaskTo3DSpace(mask);
                this.geoContext.registerObjectPoints("sofa", worldCoordinates);
              }
            }
          }
        } catch (err) {
          console.warn(`Scan segment skipped: ${err.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      // 2. Guaranteed State Restoration
      this.cameraRig.rotation.y = originalRotation;
      console.log("Spatial mapping sequence finalized.");
    }
  }

  private projectMaskTo3DSpace(mask2D: number[][]): THREE.Vector3[] {
    const points3D: THREE.Vector3[] = [];
    const height = mask2D.length;
    const width = mask2D[0].length;

    // 1. Use a step to avoid checking every single pixel (Performance Boost)
    // A step of 4 reduces operations by 16x while maintaining object shape
    const step = 4; 

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (mask2D[y][x] > 0.5) {
          
          // 2. Map coordinates with 0.5 offset for pixel-center accuracy
          const normX = (x + 0.5) / width;
          const normY = (y + 0.5) / height;

          // 3. Reuse Depth-Kernel logic
          // Note: If this still feels slow, consider reducing the kernel size 
          // inside getAnnotationPosition during the Cold Start phase.
          const worldPos = this.getAnnotationPosition(normX, normY);
          
          if (worldPos) {
            points3D.push(worldPos);
          }
        }
      }
    }

    console.log(`Lifted ${points3D.length} semantic points from mask.`);
    return points3D;
}
public async requestAnnotationFromGemini(
    clickX: number,
    clickY: number,
    clickWorldPosAtClick: THREE.Vector3 | null,
  ) {
    try {
      // 1. PRE-CHECK: Spatial Memory (Save API Costs)
      // if (clickWorldPosAtClick) {
      //   const existing = this.geoContext.findExistingObject(clickWorldPosAtClick);
      //   if (existing) {
      //       console.log(`Spatial Memory: Re-activating ${existing.label}`);
      //       // this.pulseExistingLabel(existing.id); // Visual feedback
      //       return; 
      //   }
      // }

      // 2. CAPTURE: Snapshot + Matrix State (Prevents Drift)
      const snapshot = await this.captureSnapshot(); 

      // 3. SOCKET PATH (Real-time)
      if (this.socket?.connected) {
        this.pendingSocketAnchor = clickWorldPosAtClick ? clickWorldPosAtClick.clone() : null;
        this.socket.emit("request_annotation", {
          image: snapshot.image,
          clickX,
          clickY,
          // Send matrices for backend-assisted lifting or logging
          projectionMatrix: snapshot.projectionMatrix,
          viewMatrix: snapshot.viewMatrix
        });
        return;
      }

      // 4. FETCH PATH (Standard)
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "bypass-tunnel-reminder": "true" 
      };

      const response = await fetch(buildAnnotateEndpoint(API_BASE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: snapshot.image,
          clickX,
          clickY,
        }),
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const data = await response.json();
      
      // Normalize detections array from either {objects:[]} or direct array
      const detections: AnnotationDetection[] = data.objects || (Array.isArray(data) ? data : []);

      // 5. PROCESS: Semantic Lifting & Museum Mode
      detections.forEach((detection) => {
        if (!detection?.label) return;

        // Determine 3D Position
        let finalWorldPos: THREE.Vector3 | null = null;

        if (clickWorldPosAtClick) {
            // Priority 1: User's exact click point
            finalWorldPos = clickWorldPosAtClick.clone();
        } else if (detection.box) {
            // Priority 2: Geometric center of Gemini's box
            const [ymin, xmin, ymax, xmax] = detection.box;
            finalWorldPos = this.getAnnotationPosition((xmin + xmax) / 2, (ymin + ymax) / 2);
        }

        if (finalWorldPos) {
          // Use Unified Processor (handles Memory + UI)
          // Ensure your processDetection accepts the description now
          this.processDetection(
            finalWorldPos, 
            detection.label, 
            // detection.description || "Historical 3D artifact."
          );
        }
      });
    } catch (err) {
      console.error("Museum Mode Error:", err);
    }
  }

  // public async requestAnnotationFromGemini(
  //   clickX: number,
  //   clickY: number,
  //   clickWorldPosAtClick: THREE.Vector3 | null,
  // ) {
  //   try {
  //     const dataUrl = await this.captureSnapshot();
  //     if (this.socket?.connected) {
  //       this.pendingSocketAnchor = clickWorldPosAtClick
  //         ? clickWorldPosAtClick.clone()
  //         : null;
  //       this.socket.emit("request_annotation", {
  //         image: dataUrl.image,
  //         clickX,
  //         clickY,
  //       });
  //       return;
  //     }

  //     const headers: Record<string, string> = {
  //       "Content-Type": "application/json",
  //     };
  //     if (BYPASS_TUNNEL_REMINDER) headers["bypass-tunnel-reminder"] = "true";

  //     const response = await fetch(buildAnnotateEndpoint(API_BASE_URL), {
  //       method: "POST",
  //       headers,
  //       body: JSON.stringify({
  //         image: dataUrl.image,
  //         clickX,
  //         clickY,
  //       }),
  //     });

  //     if (!response.ok) throw new Error("Server error");
  //     const data = await response.json();
  //     const detections: AnnotationDetection[] = Array.isArray(data)
  //       ? data
  //       : Array.isArray(data?.objects)
  //         ? data.objects
  //         : [];
  //     if (!Array.isArray(data) && !Array.isArray(data?.objects)) {
  //       console.warn(
  //         "Expected annotation response array or data.objects array.",
  //         data,
  //       );
  //     }

  //     const anchorWorldPos = clickWorldPosAtClick;
  //     detections.forEach((detection) => {
  //       if (
  //         !detection?.label ||
  //         !Array.isArray(detection.box) ||
  //         detection.box.length !== 4
  //       )
  //         return;
  //       if (anchorWorldPos) {
  //         this.processDetection(anchorWorldPos.clone(), detection.label);
  //         return;
  //       }
  //       this.annotateDetectedObject(
  //         detection.box as AnnotationDetection["box"],
  //         detection.label,
  //       );
  //     });
  //   } catch (err) {
  //     console.error("Museum Mode Error:", err);
  //   }
  // }
}

// Create singleton instance
export const viewer = new SplatViewer();

// Export loadWorld for compatibility with main.ts
export async function loadWorld(url: string) {
  return viewer.loadWorld(url);
}

// Initial load
const initialURL = "/Apartment.sog";
// const initialURL = "/BiltmoreGaussianSplat.ply";
loadWorld(initialURL);
