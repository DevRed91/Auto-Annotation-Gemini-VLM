import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";

/**
 * Oriented bounding box: rigid transform (position + rotation) plus full
 * size in world units. Scale is deliberately NOT baked into the matrix so the
 * shader's feather distance stays in world units.
 */
export class OBB {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly size = new THREE.Vector3(1, 1, 1);

  constructor(init?: {
    position?: THREE.Vector3;
    quaternion?: THREE.Quaternion;
    size?: THREE.Vector3;
  }) {
    if (init?.position) this.position.copy(init.position);
    if (init?.quaternion) this.quaternion.copy(init.quaternion);
    if (init?.size) this.size.copy(init.size);
  }

  /** Build from an Object3D whose geometry is a box of `geometrySize`. */
  static fromObject3D(obj: THREE.Object3D, geometrySize: THREE.Vector3): OBB {
    return new OBB().syncFromObject3D(obj, geometrySize);
  }

  /** Re-read pose/scale from an Object3D (call after it moves). */
  syncFromObject3D(obj: THREE.Object3D, geometrySize: THREE.Vector3): this {
    obj.updateWorldMatrix(true, false);
    const s = new THREE.Vector3();
    obj.matrixWorld.decompose(this.position, this.quaternion, s);
    // A mirrored object (negative scale) decomposes to a negative axis scale.
    // A box is symmetric, so only the magnitude matters; a negative half-extent
    // would make both the shader test and the ray test always fail.
    s.set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    this.size.copy(geometrySize).multiply(s);
    return this;
  }

  get halfExtents(): THREE.Vector3 {
    return this.size.clone().multiplyScalar(0.5);
  }

  /** Box local -> world (rigid, no scale). */
  getWorldMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
    return target.compose(this.position, this.quaternion, UNIT_SCALE);
  }
}
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/**
 * Ray vs OBB (slab method in box-local space). Returns hit distance along the
 * ray (world units, ray.direction assumed normalized) or null on miss.
 */
const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
export function rayIntersectsOBB(ray: THREE.Ray, obb: OBB): number | null {
  _inv.copy(obb.getWorldMatrix()).invert();
  _o.copy(ray.origin).applyMatrix4(_inv);
  _d.copy(ray.direction).transformDirection(_inv); // rigid => length preserved

  const h = obb.halfExtents;
  let tMin = 0;
  let tMax = Infinity;
  const o = [_o.x, _o.y, _o.z];
  const d = [_d.x, _d.y, _d.z];
  const e = [h.x, h.y, h.z];

  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (Math.abs(o[i]) > e[i]) return null; // parallel and outside slab
      continue;
    }
    let t1 = (-e[i] - o[i]) / d[i];
    let t2 = (e[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Nearest OBB hit along the ray (so overlapping units pick the closest). */
export function pickNearestOBB<T extends { obb: OBB }>(
  ray: THREE.Ray,
  items: Iterable<T>,
): T | null {
  let best: T | null = null;
  let bestT = Infinity;
  for (const item of items) {
    const t = rayIntersectsOBB(ray, item.obb);
    if (t !== null && t < bestT) {
      bestT = t;
      best = item;
    }
  }
  return best;
}

/**
 * Zero-extra-draw-call hover tint. Installs a Spark dyno objectModifier that
 * tints splats whose center lies inside the hovered OBB. Object modifiers run
 * in splat-local space, so we feed Inverse(boxWorld) * splatWorld.
 *
 * The modifier is appended to `splat.objectModifiers` (never overwrites other
 * modifiers). Two coordinate modes:
 *  - "world": the OBB is in world space; uniforms depend on splat.matrixWorld
 *    and must be refreshed when the splat moves (see syncSplatTransform()).
 *  - "splat": the OBB is already in splat-local space (rides with the splat);
 *    splatToBox = inverse(obbLocal), independent of splat.matrixWorld.
 */
export class HoverTint {
  private splatToBox = dyno.dynoMat4(new THREE.Matrix4());
  private halfExtents = dyno.dynoVec3(new THREE.Vector3());
  private color = dyno.dynoVec3(new THREE.Vector3(0.2, 0.9, 0.6));
  private active = dyno.dynoFloat(0);
  private strength = dyno.dynoFloat(0.45);
  private feather = dyno.dynoFloat(0.05);
  private current: OBB | null = null;
  private modifier: unknown = null;
  private lastSplatMatrix = new THREE.Matrix4();
  private space: "world" | "splat";

  private _boxInv = new THREE.Matrix4();
  private _m = new THREE.Matrix4();

  constructor(
    private splat: SplatMesh,
    opts: { space?: "world" | "splat"; color?: [number, number, number]; strength?: number } = {},
  ) {
    this.space = opts.space ?? "world";
    if (opts.color) this.color.value.set(...opts.color);
    if (opts.strength !== undefined) this.strength.value = opts.strength;
    this.install();
  }

  private install() {
    const tint = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        splatToBox: "mat4",
        halfExtents: "vec3",
        color: "vec3",
        active: "float",
        strength: "float",
        feather: "float",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) =>
        dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          if (${inputs.active} > 0.5) {
            vec3 hvLocalPos = (${inputs.splatToBox} * vec4(${inputs.gsplat}.center, 1.0)).xyz;
            vec3 hvD = abs(hvLocalPos) - ${inputs.halfExtents};
            if (hvD.x <= 0.0 && hvD.y <= 0.0 && hvD.z <= 0.0) {
              // hvD is <= 0 inside; feather over the outer band to avoid hard cuts.
              // (smoothstep with edge0 > edge1 is undefined in GLSL, so invert instead.)
              float hvEdge = max(hvD.x, max(hvD.y, hvD.z));
              float hvMask = 1.0 - smoothstep(-max(${inputs.feather}, 1e-5), 0.0, hvEdge);
              ${outputs.gsplat}.rgba.rgb = mix(
                ${inputs.gsplat}.rgba.rgb, ${inputs.color}, ${inputs.strength} * hvMask);
            }
          }
        `),
    });

    const block = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({
        gsplat: tint.apply({
          gsplat,
          splatToBox: this.splatToBox,
          halfExtents: this.halfExtents,
          color: this.color,
          active: this.active,
          strength: this.strength,
          feather: this.feather,
        }).gsplat,
      }),
    );
    this.modifier = block;
    const existing = (this.splat as any).objectModifiers ?? [];
    (this.splat as any).objectModifiers = [...existing, block];
    this.splat.updateGenerator();
  }

  setColor(r: number, g: number, b: number) {
    this.color.value.set(r, g, b);
    this.splat.updateVersion();
  }

  /** Set (or clear with null) the hovered box. Cheap no-op if unchanged. */
  setHovered(obb: OBB | null) {
    if (obb === this.current && obb === null) return;
    this.current = obb;

    if (!obb) {
      this.active.value = 0;
    } else {
      this.refresh();
      this.active.value = 1;
    }
    this.splat.updateVersion();
  }

  /** Recompute uniforms if the hovered box or the splat mesh moved. */
  refresh() {
    const obb = this.current;
    if (!obb) return;
    this.splat.updateWorldMatrix(true, false);
    this._boxInv.copy(obb.getWorldMatrix()).invert();
    if (this.space === "splat") this._m.copy(this._boxInv);
    else this._m.multiplyMatrices(this._boxInv, this.splat.matrixWorld);
    this.splatToBox.value.copy(this._m);
    this.halfExtents.value.copy(obb.halfExtents);
    this.lastSplatMatrix.copy(this.splat.matrixWorld);
  }

  /**
   * Call once per frame. In "world" mode, refreshes uniforms only if the splat's
   * world matrix changed since the last refresh. Returns true if it did.
   */
  syncSplatTransform(): boolean {
    if (!this.current || this.space === "splat") return false;
    this.splat.updateWorldMatrix(true, false);
    if (this.lastSplatMatrix.equals(this.splat.matrixWorld)) return false;
    this.refresh();
    this.splat.updateVersion();
    return true;
  }
}
