import {
  CANDIDATE_POINT_LAYOUT,
  type CandidatePoint,
  type PackedCandidates,
} from "./types";

export function packCandidatePoints(points: CandidatePoint[]): PackedCandidates {
  const floatsPerPoint = CANDIDATE_POINT_LAYOUT.floatCount;
  const uintsPerPoint = CANDIDATE_POINT_LAYOUT.uintCount;
  const strideBytes = CANDIDATE_POINT_LAYOUT.strideBytes;
  const totalBytes = points.length * strideBytes;

  const buffer = new ArrayBuffer(totalBytes);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const floatBase = i * (strideBytes / 4);

    f32[floatBase + 0] = point.position[0];
    f32[floatBase + 1] = point.position[1];
    f32[floatBase + 2] = point.position[2];
    f32[floatBase + 3] = point.depthNdc;
    f32[floatBase + 4] = point.sampleUv[0];
    f32[floatBase + 5] = point.sampleUv[1];
    f32[floatBase + 6] = point.rayDistance;
    f32[floatBase + 7] = point.depthResidual;
    f32[floatBase + 8] = point.confidence;
    f32[floatBase + 9] = 0.0;
    f32[floatBase + 10] = 0.0;

    const uintBase = floatBase + floatsPerPoint + (uintsPerPoint - 1);
    u32[uintBase] = point.flags >>> 0;
  }

  return {
    pointCount: points.length,
    data: buffer,
  };
}

