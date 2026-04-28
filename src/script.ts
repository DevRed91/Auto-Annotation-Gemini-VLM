import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement)

const spark = new SparkRenderer({ renderer });
scene.add(spark);

const splatURL = "https://sparkjs.dev/assets/splats/butterfly.spz";
const butterfly = new SplatMesh({ url: splatURL });
butterfly.quaternion.set(1, 0, 0, 0);
butterfly.position.set(0, 0, -3);
scene.add(butterfly);

renderer.setAnimationLoop(function animate(time) {
    renderer.render(scene, camera);
    butterfly.rotation.y += 0.01;
});