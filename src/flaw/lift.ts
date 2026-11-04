import type { FlawClass, LiftResult } from "./types";

/**
 * Single-view region lifting (plan M3, view 0 only).
 *
 * Projects every Gaussian centre through the camera that took the diagnosis
 * snapshot and keeps the ones that land inside the region mask and are not
 * hidden behind the visible surface. Multi-view probe voting is not
 * implemented yet, so `votes` is left unset and pruning order falls back to
 * store index.
 */
export interface LiftInput {
  /** World-space Gaussian centres, xyz interleaved. */
  centers: Float32Array;
  /** Activated opacity in [0, 1]. */
  alphas: Float32Array;
  /** World-space largest axis scale (already exponentiated). */
  radii: Float32Array;
  /** Gaussians to ignore (e.g. already pruned). */
  skip?: Uint8Array;
  /** Column-major projection * view matrix of the snapshot camera. */
  viewProjection: ArrayLike<number>;
  mask: Uint8Array;
  width: number;
  height: number;
  /** Normalised [minX, minY, maxX, maxY] of the mask component. */
  bbox: [number, number, number, number];
  class: FlawClass;
}

export interface LiftOptions {
  tile: number;
  /** Visible if depth <= surface * (1 + visibleSlack). */
  visibleSlack: number;
  /** Foreground outlier if depth < background * (1 - outlierMargin). */
  outlierMargin: number;
  /**
   * Supported if at least this many Gaussians (at any depth) lie within supportScale * radius.
   * Counting all neighbours keeps dense foreground objects, which are also nearer than the
   * background, from being flagged; only sparse, isolated foreground blobs become detached.
   */
  minNeighbours: number;
  supportScale: number;
  /** Floor for the neighbour search radius, in world units. */
  minSupportRadius: number;
}

export interface LiftStats {
  projected: number;
  insideMask: number;
  selected: number;
  detached: number;
  backgroundDepth: number;
}

const defaults: LiftOptions = {
  tile: 8, visibleSlack: 0.02, outlierMargin: 0.05, minNeighbours: 3, supportScale: 2, minSupportRadius: 0.005,
};

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Depth at which front-to-back transmittance first drops below 0.5. */
function surfaceDepth(entries: { depth: number; alpha: number }[]): number {
  if (!entries.length) return Number.NaN;
  entries.sort((a, b) => a.depth - b.depth);
  let transmittance = 1;
  for (const entry of entries) {
    transmittance *= 1 - Math.min(0.999, Math.max(0, entry.alpha));
    if (transmittance < 0.5) return entry.depth;
  }
  return entries[entries.length - 1].depth;
}

export function liftRegion(input: LiftInput, options: Partial<LiftOptions> = {}): { result: LiftResult; stats: LiftStats } {
  const o = { ...defaults, ...options };
  const { centers, alphas, radii, skip, viewProjection: m, mask, width, height } = input;
  const count = alphas.length;
  if (centers.length !== count * 3 || radii.length !== count || mask.length !== width * height) {
    throw new Error("Lift input arrays have inconsistent sizes");
  }

  // Region of interest: mask bbox dilated by 50% on each side, used for the
  // background ring and for the neighbour search.
  const [bx0, by0, bx1, by1] = input.bbox;
  const padX = Math.max((bx1 - bx0) * 0.5, 0.02);
  const padY = Math.max((by1 - by0) * 0.5, 0.02);
  const rx0 = Math.max(0, (bx0 - padX) * width), rx1 = Math.min(width, (bx1 + padX) * width);
  const ry0 = Math.max(0, (by0 - padY) * height), ry1 = Math.min(height, (by1 + padY) * height);

  const tilesX = Math.ceil(width / o.tile);
  const tiles = new Map<number, { depth: number; alpha: number }[]>();
  const tileInMask = new Set<number>();
  const roi: number[] = [];
  const roiDepth: number[] = [];
  const roiPixel: number[] = [];
  let projected = 0;

  for (let i = 0; i < count; i++) {
    if (skip?.[i]) continue;
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 1e-6)) continue;
    const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
    projected++;
    const px = (ndcX * 0.5 + 0.5) * width;
    const py = (0.5 - ndcY * 0.5) * height;
    if (px < rx0 || px >= rx1 || py < ry0 || py >= ry1) continue;
    const pixelX = Math.min(width - 1, Math.floor(px)), pixelY = Math.min(height - 1, Math.floor(py));
    const pixel = pixelY * width + pixelX;
    const tile = Math.floor(pixelY / o.tile) * tilesX + Math.floor(pixelX / o.tile);
    let list = tiles.get(tile);
    if (!list) tiles.set(tile, list = []);
    list.push({ depth: w, alpha: alphas[i] });
    if (mask[pixel]) tileInMask.add(tile);
    roi.push(i);
    roiDepth.push(w);
    roiPixel.push(pixel);
  }

  const tileSurface = new Map<number, number>();
  const ringSurfaces: number[] = [];
  for (const [tile, list] of tiles) {
    const depth = surfaceDepth(list);
    tileSurface.set(tile, depth);
    if (!tileInMask.has(tile)) ringSurfaces.push(depth);
  }
  // Without any ring (mask covers the whole ROI) fall back to the in-mask tiles.
  const backgroundDepth = median(ringSurfaces.length ? ringSurfaces : [...tileSurface.values()]);

  // Neighbour support uses a spatial hash over every Gaussian in the ROI.
  let cell = o.minSupportRadius;
  const roiRadii = roi.map(i => Math.max(o.minSupportRadius, radii[i] * o.supportScale));
  if (roiRadii.length) cell = Math.max(cell, median(roiRadii));
  const key = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;
  const grid = new Map<string, number[]>();
  roi.forEach((i, row) => {
    const k = key(Math.floor(centers[i * 3] / cell), Math.floor(centers[i * 3 + 1] / cell), Math.floor(centers[i * 3 + 2] / cell));
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, bucket = []);
    bucket.push(row);
  });
  const isOutlier = (depth: number) => Number.isFinite(backgroundDepth) && depth < backgroundDepth * (1 - o.outlierMargin);
  const neighbours = (row: number, radius: number, limit: number) => {
    const i = roi[row];
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    // Capped so one huge Gaussian cannot turn the search into a full scan.
    const reach = Math.min(2, Math.ceil(radius / cell));
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let found = 0;
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
      for (const other of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        if (other === row) continue;
        const j = roi[other];
        const ex = centers[j * 3] - x, ey = centers[j * 3 + 1] - y, ez = centers[j * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= radius * radius && ++found >= limit) return found;
      }
    }
    return found;
  };

  const indices: number[] = [];
  const detached: number[] = [];
  let insideMask = 0;
  roi.forEach((i, row) => {
    const pixel = roiPixel[row];
    if (!mask[pixel]) return;
    insideMask++;
    const depth = roiDepth[row];
    const x = pixel % width, y = Math.floor(pixel / width);
    const surface = tileSurface.get(Math.floor(y / o.tile) * tilesX + Math.floor(x / o.tile))!;
    // Hidden behind both the local surface and the background: not responsible for what was seen.
    if (depth > Math.max(surface, Number.isFinite(backgroundDepth) ? backgroundDepth : surface) * (1 + o.visibleSlack)) return;
    const outlier = isOutlier(depth);
    const supported = outlier && neighbours(row, roiRadii[row], o.minNeighbours) >= o.minNeighbours;
    indices.push(i);
    detached.push(outlier && !supported ? 1 : 0);
  });

  return {
    result: { indices: Uint32Array.from(indices), class: input.class, detached: Uint8Array.from(detached) },
    stats: { projected, insideMask, selected: indices.length, detached: detached.reduce((a, b) => a + b, 0), backgroundDepth },
  };
}
