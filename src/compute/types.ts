export type ComputePassName =
  | "candidateFilter"
  | "visibilityScore"
  | "neighborSearch";

export interface CandidatePoint {
  position: [number, number, number];
  depthNdc: number;
  sampleUv: [number, number];
  rayDistance: number;
  depthResidual: number;
  flags: number;
  confidence: number;
}

export interface CandidatePointBufferLayout {
  strideBytes: number;
  floatCount: number;
  uintCount: number;
}

export const CANDIDATE_POINT_LAYOUT: CandidatePointBufferLayout = {
  strideBytes: 48,
  floatCount: 11,
  uintCount: 1,
};

export interface PackedCandidates {
  pointCount: number;
  data: ArrayBuffer;
}

export interface BufferLease {
  key: string;
  size: number;
  usage: GPUBufferUsageFlags;
  buffer: GPUBuffer;
}

export interface BufferPoolStats {
  capacity: number;
  inUse: number;
  totalBytes: number;
}

export interface PipelineRegistryEntry {
  name: ComputePassName;
  pipeline: GPUComputePipeline;
}

export interface ReadbackResult {
  size: number;
  data: ArrayBuffer;
}

export interface ComputeCapabilities {
  webgpuSupported: boolean;
  adapterName: string | null;
  initialized: boolean;
}

