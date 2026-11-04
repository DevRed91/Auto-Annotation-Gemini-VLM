import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import type { GaussianStore } from "./GaussianStore";

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** World-space attributes for lifting, derived from the raw store and the mesh transform. */
export function buildWorldAttributes(store: GaussianStore, matrixWorld: THREE.Matrix4) {
  const count = store.vertexCount;
  const centers = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const radii = new Float32Array(count);
  const e = matrixWorld.elements;
  const scaleFactor = matrixWorld.getMaxScaleOnAxis();
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.set(store.get(i, "x"), store.get(i, "y"), store.get(i, "z"));
    centers[i * 3] = e[0] * point.x + e[4] * point.y + e[8] * point.z + e[12];
    centers[i * 3 + 1] = e[1] * point.x + e[5] * point.y + e[9] * point.z + e[13];
    centers[i * 3 + 2] = e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14];
    alphas[i] = sigmoid(store.get(i, "opacity"));
    radii[i] = Math.exp(Math.max(store.get(i, "scale_0"), store.get(i, "scale_1"), store.get(i, "scale_2"))) * scaleFactor;
  }
  return { centers, alphas, radii };
}

type EditableSplats = NonNullable<SplatMesh["packedSplats"]> | NonNullable<SplatMesh["extSplats"]>;

/**
 * Returns the mesh's splat buffer only if its indices provably match the PLY
 * store order; otherwise edits cannot be previewed safely.
 */
export function editableSplats(mesh: SplatMesh, store: GaussianStore): EditableSplats | null {
  const splats = mesh.packedSplats ?? mesh.extSplats;
  if (!splats || splats.numSplats !== store.vertexCount) return null;
  const samples = Math.min(64, store.vertexCount);
  for (let s = 0; s < samples; s++) {
    const i = Math.floor((s * (store.vertexCount - 1)) / Math.max(1, samples - 1));
    const { center } = splats.getSplat(i);
    const expected = new THREE.Vector3(store.get(i, "x"), store.get(i, "y"), store.get(i, "z"));
    // PackedSplats stores centres as float16, so allow quantisation error.
    if (center.distanceTo(expected) > 1e-2 * Math.max(1, expected.length())) return null;
  }
  return splats;
}

/** Pushes the store's current opacity/scale/prune state for `indices` into the renderer. */
export function syncSplats(splats: EditableSplats, store: GaussianStore, indices: Iterable<number>): void {
  for (const i of indices) {
    const splat = splats.getSplat(i);
    const opacity = store.isPruned[i] ? 0 : sigmoid(store.get(i, "opacity"));
    const scales = new THREE.Vector3(
      Math.exp(store.get(i, "scale_0")), Math.exp(store.get(i, "scale_1")), Math.exp(store.get(i, "scale_2")));
    splats.setSplat(i, splat.center, scales, splat.quaternion, opacity, splat.color);
  }
  if ("needsUpdate" in splats) {
    splats.needsUpdate = true;
  } else {
    // ExtSplats only re-uploads when its backing buffer is replaced, so flag in-place edits.
    splats.textures[0].needsUpdate = true;
    splats.textures[1].needsUpdate = true;
  }
}

/** Neon-yellow point overlay at the centres of the selected Gaussians. */
export function createHighlight(centers: Float32Array, indices: Uint32Array, detached?: Uint8Array): THREE.Points {
  const positions = new Float32Array(indices.length * 3);
  const colors = new Float32Array(indices.length * 3);
  const selected = new THREE.Color(0xdfff00);
  const removable = new THREE.Color(0xff3b30);
  indices.forEach((index, row) => {
    positions.set(centers.subarray(index * 3, index * 3 + 3), row * 3);
    (detached?.[row] ? removable : selected).toArray(colors, row * 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 3, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, opacity: 0.85,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 999;
  points.name = "FlawSelectionHighlight";
  return points;
}

export function disposeHighlight(points: THREE.Points | null): void {
  if (!points) return;
  points.removeFromParent();
  points.geometry.dispose();
  (points.material as THREE.Material).dispose();
}
