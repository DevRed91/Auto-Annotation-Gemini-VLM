import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export class SplatViewer {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderer: THREE.WebGLRenderer;
    private spark: SparkRenderer;
    private currentSplat: SplatMesh | null = null;

    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        document.body.appendChild(this.renderer.domElement);

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
        this.renderer.setAnimationLoop((_time: number) => {
            this.renderer.render(this.scene, this.camera);
            if (this.currentSplat) {
                this.currentSplat.rotation.y += 0.005;
            }
        });
    }

    public async loadWorld(url: string) {
        if (this.currentSplat) {
            this.scene.remove(this.currentSplat);
            // Assuming there's a dispose method, but it was commented out in original
            // if ('dispose' in this.currentSplat) (this.currentSplat as any).dispose();
        }

        const splat = new SplatMesh({ url });
        splat.quaternion.set(1, 0, 0, 0);
        splat.position.set(0, 0, -3);
        this.scene.add(splat);
        this.currentSplat = splat;
    }
}

// Create singleton instance
export const viewer = new SplatViewer();

// Export loadWorld for compatibility with main.ts
export async function loadWorld(url: string) {
    return viewer.loadWorld(url);
}

// Initial load
const initialURL = "https://sparkjs.dev/assets/splats/butterfly.spz";
loadWorld(initialURL);

