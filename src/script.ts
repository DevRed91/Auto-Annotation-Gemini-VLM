import * as THREE from "three";
import { SparkControls, SparkRenderer, SplatMesh, dyno } from "@sparkjsdev/spark";
import { setupSplatModifier } from "./utils/utils";
import { getMobileInput, getMobileLook, initMobileControls, isMobileDevice } from "./utils/mobileJoystick";
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

    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
        this.cameraRig = new THREE.Group();
        this.cameraRig.add(this.camera);
        this.cameraRig.position.set(0, 0, -3);
        this.cameraRig.rotateY(Math.PI);
        this.scene.add(this.cameraRig);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        document.body.appendChild(this.renderer.domElement);
        this.controls = new SparkControls({ canvas: this.renderer.domElement });


        this.spark = new SparkRenderer({ renderer: this.renderer });
        this.scene.add(this.spark);
        this.setMobileControls();
        this.setupEventListeners();
        this.startAnimationLoop();
    }

    private setupEventListeners() {
        window.addEventListener('resize', () => this.onWindowResize());
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
            this.lockCameraHeightToGround();
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
            this.renderer.render(this.scene, this.camera);
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
            this.camera.rotation.x = Math.max(-maxPitch, Math.min(maxPitch, this.camera.rotation.x));
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
            side: THREE.DoubleSide
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
}

// Create singleton instance
export const viewer = new SplatViewer();

// Export loadWorld for compatibility with main.ts
export async function loadWorld(url: string) {
    return viewer.loadWorld(url);
}

// Initial load
// const initialURL = "/Apartment.splat";
const initialURL = "/Apartment.sog";
loadWorld(initialURL);

