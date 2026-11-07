import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";
import type { GsplatModifier } from "@sparkjsdev/spark";
import { assertNonLodSplat } from "./gaussianIndexSupport";

const MASK_WIDTH = 4096;
const EMPTY_IDS: readonly number[] = [];

export interface GaussianMaskUpdate {
  changed: boolean;
  validIds: number;
  duplicateIds: number;
  invalidIds: number;
  changedBytes: number;
  /** CPU validation, deduplication and changed-byte writes. */
  rewriteMs: number;
  /** CPU submission work only: needsUpdate plus Spark version invalidation. */
  submissionMs: number;
}

/**
 * One optional, per-storage-index highlight modifier for a non-LOD SplatMesh.
 * It owns only its R8UI texture and its own entry in objectModifiers.
 */
export class GaussianMaskManager {
  readonly texture: THREE.DataTexture;
  readonly numSplats: number;

  private readonly splat: SplatMesh;
  private readonly modifier: GsplatModifier;
  private readonly data: Uint8Array;
  private selected = new Uint32Array(0);
  private disposed = false;
  private submissions = 0;

  static async create(splat: SplatMesh): Promise<GaussianMaskManager> {
    await splat.initialized;
    assertNonLodSplat(splat, "Gaussian masks");
    if (!Number.isSafeInteger(splat.numSplats) || splat.numSplats < 0) {
      throw new RangeError("splat.numSplats must be a non-negative safe integer");
    }
    return new GaussianMaskManager(splat);
  }

  private constructor(splat: SplatMesh) {
    this.splat = splat;
    this.numSplats = splat.numSplats;
    const rows = Math.max(1, Math.ceil(this.numSplats / MASK_WIDTH));
    this.data = new Uint8Array(MASK_WIDTH * rows);
    this.texture = new THREE.DataTexture(
      this.data,
      MASK_WIDTH,
      rows,
      THREE.RedIntegerFormat,
      THREE.UnsignedByteType,
    );
    this.texture.internalFormat = "R8UI";
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    const mask = dyno.dynoUsampler2D(this.texture);
    const numSplats = dyno.dynoInt(this.numSplats);
    const color = dyno.dynoVec3(new THREE.Vector3(1, 0, 1));
    const strength = dyno.dynoFloat(0.9);
    const tint = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        mask: "usampler2D",
        numSplats: "int",
        color: "vec3",
        strength: "float",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        int gmIndex = ${inputs.gsplat}.index;
        if (gmIndex >= 0 && gmIndex < ${inputs.numSplats}) {
          uint gmSelected = texelFetch(
            ${inputs.mask}, ivec2(gmIndex & 4095, gmIndex >> 12), 0).r;
          if (gmSelected > 0u) {
            ${outputs.gsplat}.rgba.rgb = mix(
              ${inputs.gsplat}.rgba.rgb, ${inputs.color}, ${inputs.strength});
          }
        }
      `),
    });
    this.modifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({
        gsplat: tint.apply({ gsplat, mask, numSplats, color, strength }).gsplat,
      }),
    );

    splat.objectModifiers = [...(splat.objectModifiers ?? []), this.modifier];
    splat.updateGenerator();
  }

  get count(): number {
    return this.selected.length;
  }

  get selectedIds(): Uint32Array {
    return this.selected.slice();
  }

  get uploadSubmissions(): number {
    return this.submissions;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Replace membership, ignoring duplicate and invalid IDs. */
  replace(ids: ArrayLike<number>): GaussianMaskUpdate {
    if (this.disposed) throw new Error("GaussianMaskManager has been disposed");
    if (!ids || !Number.isSafeInteger(ids.length) || ids.length < 0) {
      throw new TypeError("ids must be an array-like collection of storage indices");
    }

    const rewriteStart = performance.now();
    const next = new Set<number>();
    let duplicateIds = 0;
    let invalidIds = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!Number.isSafeInteger(id) || id < 0 || id >= this.numSplats) {
        invalidIds++;
      } else if (next.has(id)) {
        duplicateIds++;
      } else {
        next.add(id);
      }
    }

    let changed = false;
    let changedBytes = 0;
    for (const id of this.selected) {
      if (!next.has(id) && this.data[id] !== 0) {
        this.data[id] = 0;
        changed = true;
        changedBytes++;
      }
    }
    for (const id of next) {
      if (this.data[id] !== 1) {
        this.data[id] = 1;
        changed = true;
        changedBytes++;
      }
    }
    this.selected = Uint32Array.from(next).sort();
    const rewriteMs = performance.now() - rewriteStart;

    let submissionMs = 0;
    if (changed) {
      const submissionStart = performance.now();
      this.texture.needsUpdate = true;
      this.submissions++;
      this.splat.updateVersion();
      submissionMs = performance.now() - submissionStart;
    }
    return {
      changed,
      validIds: next.size,
      duplicateIds,
      invalidIds,
      changedBytes,
      rewriteMs,
      submissionMs,
    };
  }

  clear(): GaussianMaskUpdate {
    return this.replace(EMPTY_IDS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const existing = this.splat.objectModifiers ?? [];
    const remaining = existing.filter((modifier) => modifier !== this.modifier);
    if (remaining.length !== existing.length) {
      this.splat.objectModifiers = remaining;
      this.splat.updateGenerator();
    }
    this.selected = new Uint32Array(0);
    this.texture.dispose();
  }
}
