import { GPUBufferPool } from "./buffers";
import type {
  BufferLease,
  ComputeCapabilities,
  ComputePassName,
  ReadbackResult,
} from "./types";

export class WebGPUComputeService {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private queue: GPUQueue | null = null;
  private readonly bufferPool = new GPUBufferPool();
  private readonly pipelines = new Map<ComputePassName, GPUComputePipeline>();
  private initialized = false;

  public async init(): Promise<boolean> {
    if (this.initialized) return true;
    if (!("gpu" in navigator)) return false;

    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;

    const device = await adapter.requestDevice();

    this.adapter = adapter;
    this.device = device;
    this.queue = device.queue;
    this.initialized = true;
    return true;
  }

  public isInitialized(): boolean {
    return this.initialized && this.device !== null && this.queue !== null;
  }

  public getCapabilities(): ComputeCapabilities {
    const hasGpu = "gpu" in navigator;
    let adapterName: string | null = null;
    if (this.adapter && "info" in this.adapter) {
      const info = (
        this.adapter as GPUAdapter & { info?: { description?: string } }
      ).info;
      adapterName = info?.description ?? null;
    }

    return {
      webgpuSupported: hasGpu,
      adapterName,
      initialized: this.isInitialized(),
    };
  }

  public getDeviceOrThrow(): GPUDevice {
    if (!this.device) {
      throw new Error("WebGPUComputeService is not initialized.");
    }
    return this.device;
  }

  public createCommandEncoder(label?: string): GPUCommandEncoder {
    const device = this.getDeviceOrThrow();
    return device.createCommandEncoder({ label });
  }

  public submit(encoder: GPUCommandEncoder): void {
    if (!this.queue) {
      throw new Error("WebGPU queue is unavailable.");
    }
    this.queue.submit([encoder.finish()]);
  }

  public registerPipeline(
    name: ComputePassName,
    pipeline: GPUComputePipeline,
  ): void {
    this.pipelines.set(name, pipeline);
  }

  public getPipeline(name: ComputePassName): GPUComputePipeline | null {
    return this.pipelines.get(name) ?? null;
  }

  public acquireBuffer(
    key: string,
    byteLength: number,
    usage: GPUBufferUsageFlags,
  ): BufferLease {
    const device = this.getDeviceOrThrow();
    return this.bufferPool.acquire(device, key, byteLength, usage);
  }

  public releaseBuffer(lease: BufferLease): void {
    this.bufferPool.release(lease);
  }

  public resetPoolLeases(): void {
    this.bufferPool.resetAll();
  }

  public getBufferPoolStats() {
    return this.bufferPool.getStats();
  }

  public resetCounterBuffer(target: GPUBuffer): void {
    const device = this.getDeviceOrThrow();
    if (!this.queue) {
      throw new Error("WebGPU queue is unavailable.");
    }
    GPUBufferPool.writeCounterZero(device, this.queue, target);
  }

  public async readbackBuffer(
    source: GPUBuffer,
    byteLength: number,
  ): Promise<ReadbackResult> {
    const device = this.getDeviceOrThrow();
    if (!this.queue) {
      throw new Error("WebGPU queue is unavailable.");
    }

    const size = Math.max(4, byteLength);
    const staging = device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      mappedAtCreation: false,
    });

    const encoder = device.createCommandEncoder({
      label: "readback-encoder",
    });
    encoder.copyBufferToBuffer(source, 0, staging, 0, size);
    this.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const mapped = staging.getMappedRange();
    const copied = mapped.slice(0);
    staging.unmap();
    staging.destroy();

    return {
      size,
      data: copied,
    };
  }

  public destroy(): void {
    this.pipelines.clear();
    this.bufferPool.destroy();
    this.device = null;
    this.adapter = null;
    this.queue = null;
    this.initialized = false;
  }
}

