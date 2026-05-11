import * as THREE from "three";
import { SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { setupSplatModifier } from "./utils/utils";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

export class SplatViewer {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderer: THREE.WebGLRenderer;
    private spark: SparkRenderer;
    private controls: SparkControls;
    private currentSplat: SplatMesh | null = null;
    private raycaster = new THREE.Raycaster();
    private down = new THREE.Vector3(0, -1, 0);
    private desiredCameraHeight = 1.7;
    private groundPlane: THREE.Mesh | null = null;

    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
        this.camera.position.set(0, 0, -3);
        this.camera.lookAt(-1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        document.body.appendChild(this.renderer.domElement);
        this.controls = new SparkControls({ canvas: this.renderer.domElement });

        this.spark = new SparkRenderer({ renderer: this.renderer });
        this.scene.add(this.spark);

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
        this.renderer.setAnimationLoop(() => {
            this.controls.update(this.camera);
            // this.lockCameraHeightToGround();
            this.renderer.render(this.scene, this.camera);
        });
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
            // Assuming there's a dispose method, but it was commented out in original
            // if ('dispose' in this.currentSplat) (this.currentSplat as any).dispose();
        }

        const splat = new SplatMesh({ url });
        splat.quaternion.set(1, 0, 0, 0);
        splat.position.set(0, -1.7, 0);
        // setupSplatModifier(splat);
        this.scene.add(splat);
        // this.addGroundPlane();
        this.currentSplat = splat;
    }
    private lockCameraHeightToGround() {
        if (!this.groundPlane) return;

        this.raycaster.set(this.camera.position, this.down);
        const hits = this.raycaster.intersectObject(this.groundPlane, false);

        if (hits.length === 0) return;

        const groundY = hits[0].point.y;
        this.camera.position.y = groundY + this.desiredCameraHeight;
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

