import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { HoverTint, OBB } from "../utils/hoverTint";
import { GaussianIdProbe } from "./gaussianIdProbe";

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(640, 480);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.01, 1000);
const spark = new SparkRenderer({ renderer });
scene.add(spark);

const url = new URLSearchParams(location.search).get("url") ?? "/Apartment.sog";
const splat = new SplatMesh({ url });
splat.quaternion.set(1, 0, 0, 0);
splat.position.set(0, -1.5, 0);
scene.add(splat);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function frames(n = 8) {
  for (let i = 0; i < n; i++) { renderer.render(scene, camera); await sleep(60); }
}
function pixels(): Uint8Array {
  const gl = renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const out = new Uint8Array(w * h * 4); (gl as WebGL2RenderingContext).bindBuffer((gl as WebGL2RenderingContext).PIXEL_PACK_BUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out); return out;
}
function diff(a: Uint8Array, b: Uint8Array, tol = 2) {
  let n = 0; for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i+1] - b[i+1]) > tol || Math.abs(a[i+2] - b[i+2]) > tol) n++;
  return n;
}

(async () => {
  await splat.initialized;
  const h: any = { THREE, renderer, scene, camera, splat, frames, pixels, diff, sleep };
  h.numSplats = splat.numSplats;
  h.lod = !!(splat as any).lod || !!(splat as any).enableLod;
  h.hover = new HoverTint(splat);
  h.OBB = OBB;
  h.probe = new GaussianIdProbe(splat, splat.numSplats);
  const centers = new Float32Array(splat.numSplats * 3);
  splat.forEachSplat((i: number, c: THREE.Vector3) => { centers[i*3]=c.x; centers[i*3+1]=c.y; centers[i*3+2]=c.z; });
  h.centers = centers;
  (window as any).h = h; (window as any).ready = true;
})();
