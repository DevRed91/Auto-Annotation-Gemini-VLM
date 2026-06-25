import type { BufferLease, BufferPoolStats } from "./types";

interface BufferSlot {
  key: string;
  usage: GPUBufferUsageFlags;
  size: number;
  buffer: GPUBuffer;
  inUse: boolean;
}

function alignTo(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

export class GPUBufferPool {
  private readonly slots: BufferSlot[] = [];
  private readonly alignment: number;

  constructor(alignment = 256) {
    this.alignment = alignment;
  }

  public acquire(
    device: GPUDevice,
    key: string,
    byteLength: number,
    usage: GPUBufferUsageFlags,
  ): BufferLease {
    const targetSize = alignTo(Math.max(byteLength, 4), this.alignment);
    const existing = this.slots.find(
      (slot) =>
        !slot.inUse &&
        slot.key === key &&
        slot.usage === usage &&
        slot.size >= targetSize,
    );

    if (existing) {
      existing.inUse = true;
      return {
        key: existing.key,
        size: existing.size,
        usage: existing.usage,
        buffer: existing.buffer,
      };
    }

    const created = device.createBuffer({
      size: targetSize,
      usage,
      mappedAtCreation: false,
    });
    const slot: BufferSlot = {
      key,
      usage,
      size: targetSize,
      buffer: created,
      inUse: true,
    };
    this.slots.push(slot);
    return { key, size: targetSize, usage, buffer: created };
  }

  public release(lease: BufferLease): void {
    const slot = this.slots.find((item) => item.buffer === lease.buffer);
    if (!slot) return;
    slot.inUse = false;
  }

  public resetAll(): void {
    for (const slot of this.slots) {
      slot.inUse = false;
    }
  }

  public destroy(): void {
    for (const slot of this.slots) {
      slot.buffer.destroy();
    }
    this.slots.length = 0;
  }

  public getStats(): BufferPoolStats {
    let inUse = 0;
    let totalBytes = 0;

    for (const slot of this.slots) {
      totalBytes += slot.size;
      if (slot.inUse) inUse += 1;
    }

    return {
      capacity: this.slots.length,
      inUse,
      totalBytes,
    };
  }

  public static writeCounterZero(
    device: GPUDevice,
    queue: GPUQueue,
    target: GPUBuffer,
  ): void {
    const staging = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const view = new Uint32Array(staging.getMappedRange());
    view[0] = 0;
    staging.unmap();

    const encoder = device.createCommandEncoder({
      label: "counter-reset-encoder",
    });
    encoder.copyBufferToBuffer(staging, 0, target, 0, 4);
    queue.submit([encoder.finish()]);
    staging.destroy();
  }
}

