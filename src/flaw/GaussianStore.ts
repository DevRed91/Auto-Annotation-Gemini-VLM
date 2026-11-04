interface Property {
  name: string;
  type: string;
  offset: number;
  size: number;
}
const typeInfo: Record<string, {
  size: number;
  getter: keyof DataView;
  setter: keyof DataView;
}> = {
  float32: { size: 4, getter: "getFloat32", setter: "setFloat32" }, float64: { size: 8, getter: "getFloat64", setter: "setFloat64" },
  float: { size: 4, getter: "getFloat32", setter: "setFloat32" }, double: { size: 8, getter: "getFloat64", setter: "setFloat64" },
  uchar: { size: 1, getter: "getUint8", setter: "setUint8" }, uint8: { size: 1, getter: "getUint8", setter: "setUint8" }, char: { size: 1, getter: "getInt8", setter: "setInt8" }, int8: { size: 1, getter: "getInt8", setter: "setInt8" },
  short: { size: 2, getter: "getInt16", setter: "setInt16" }, int16: { size: 2, getter: "getInt16", setter: "setInt16" }, ushort: { size: 2, getter: "getUint16", setter: "setUint16" }, uint16: { size: 2, getter: "getUint16", setter: "setUint16" },
  int: { size: 4, getter: "getInt32", setter: "setInt32" }, int32: { size: 4, getter: "getInt32", setter: "setInt32" }, uint: { size: 4, getter: "getUint32", setter: "setUint32" }, uint32: { size: 4, getter: "getUint32", setter: "setUint32" },
};
/** Takes ownership of input bytes; callers must not mutate them.
 * Editable, raw-space representation of a binary little-endian Gaussian PLY. */
export class GaussianStore {
  readonly fileBytes: Uint8Array;
  readonly headerBytes: Uint8Array;
  readonly vertexCount: number;
  readonly stride: number;
  private readonly view: DataView;
  private readonly properties = new Map<string, Property>();
  private readonly rowsStart: number;
  private readonly originalValues = new Map<number, Uint8Array>();
  private changedBytes = 0;
  private prunedCount = 0;
  private pruned = new Uint8Array();
  private constructor(bytes: Uint8Array, headerBytes: Uint8Array, rowsStart: number, vertexCount: number, stride: number, properties: Property[]) {
    this.fileBytes = bytes;
    this.headerBytes = headerBytes;
    this.rowsStart = rowsStart;
    this.vertexCount = vertexCount;
    this.stride = stride;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pruned = new Uint8Array(vertexCount);
    properties.forEach((property) => this.properties.set(property.name, property));
  }
  static fromBytes(input: ArrayBuffer | Uint8Array): GaussianStore {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const terminator = new TextEncoder().encode("end_header");
    let newline = -1;
    for (let i = 0; i < Math.min(bytes.length, 2000000) - terminator.length; i++) {
      if (i > 0 && bytes[i - 1] !== 10)
        continue;
      if (!terminator.every((value, offset) => bytes[i + offset] === value))
        continue;
      const after = i + terminator.length;
      if (bytes[after] === 10)
        newline = after;
      else if (bytes[after] === 13 && bytes[after + 1] === 10)
        newline = after + 1;
      if (newline >= 0)
        break;
    }
    if (newline < 0)
      throw new Error("Invalid PLY: missing end_header newline");
    const headerText = new TextDecoder().decode(bytes.subarray(0, newline + 1));
    const format = headerText.match(/^format\s+(\S+)/m)?.[1];
    if (format !== "binary_little_endian")
      throw new Error("Only binary_little_endian PLY files are supported");
    const count = Number(headerText.match(/^element\s+vertex\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(count) || count < 0)
      throw new Error("PLY has no valid vertex element");
    const properties: Property[] = [];
    let offset = 0;
    let element = "";
    let prefixSize = 0;
    let elementCount = 0;
    let seenVertex = false;
    for (const line of headerText.split(/\r?\n/)) {
      const elementMatch = line.match(/^element\s+(\S+)\s+(\d+)/);
      if (elementMatch) {
        element = elementMatch[1];
        elementCount = Number(elementMatch[2]);
        if (element === "vertex")
          seenVertex = true;
        continue;
      }
      const match = line.match(/^property\s+(\S+)\s+(\S+)/);
      if (!match || (seenVertex && element !== "vertex"))
        continue;
      const info = Object.hasOwn(typeInfo, match[1]) ? typeInfo[match[1]] : undefined;
      if (!info)
        throw new Error(`Unsupported PLY property type before or in vertex: ${match[1]}`);
      if (element !== "vertex") {
        prefixSize += elementCount * info.size;
        continue;
      }
      properties.push({ name: match[2], type: match[1], offset, size: info.size });
      offset += info.size;
    }
    if (!properties.length || !bytes.byteLength || newline + 1 + prefixSize + count * offset > bytes.length)
      throw new Error("Invalid PLY vertex data");
    return new GaussianStore(bytes, bytes.subarray(0, newline + 1), newline + 1 + prefixSize, count, offset, properties);
  }
  get hasEdits(): boolean { return this.changedBytes > 0 || this.prunedCount > 0; }
  get isPruned(): Uint8Array { return this.pruned; }
  has(name: string): boolean { return this.properties.has(name); }
  get(index: number, name: string): number {
    const property = this.properties.get(name);
    if (!property)
      return Number.NaN;
    this.checkIndex(index);
    const info = typeInfo[property.type];
    return Number((this.view[info.getter] as (offset: number, littleEndian?: boolean) => number)(this.rowsStart + index * this.stride + property.offset, true));
  }
  set(index: number, name: string, value: number): void {
    const property = this.properties.get(name);
    if (!property)
      return;
    this.checkIndex(index);
    const info = typeInfo[property.type];
    const address = this.rowsStart + index * this.stride + property.offset;
    const original = this.originalValues.get(address) ?? this.fileBytes.slice(address, address + property.size);
    const before = this.fileBytes.subarray(address, address + property.size);
    this.changedBytes -= before.reduce((sum, byte, i) => sum + Number(byte !== original[i]), 0);
    (this.view[info.setter] as (offset: number, value: number, littleEndian?: boolean) => void)(address, value, true);
    const differences = before.reduce((sum, byte, i) => sum + Number(byte !== original[i]), 0);
    this.changedBytes += differences;
    if (differences)
      this.originalValues.set(address, original);
    else
      this.originalValues.delete(address);
  }
  markPruned(index: number, value = true): void {
    this.checkIndex(index);
    const next = value ? 1 : 0;
    this.prunedCount += next - this.pruned[index];
    this.pruned[index] = next;
  }
  values(index: number, names: string[]): number[] { return names.map((name) => this.get(index, name)); }
  exportBytes(): Uint8Array<ArrayBuffer> {
    if (!this.prunedCount)
      return new Uint8Array(this.fileBytes);
    const header = new TextDecoder().decode(this.headerBytes).replace(/(element\s+vertex\s+)\d+/, `$1${this.vertexCount - this.prunedCount}`);
    const headerBytes = new TextEncoder().encode(header);
    const prefix = this.fileBytes.subarray(this.headerBytes.length, this.rowsStart);
    const suffix = this.fileBytes.subarray(this.rowsStart + this.vertexCount * this.stride);
    const result = new Uint8Array(headerBytes.length + prefix.length + (this.vertexCount - this.prunedCount) * this.stride + suffix.length);
    result.set(headerBytes);
    result.set(prefix, headerBytes.length);
    let destination = headerBytes.length + prefix.length;
    for (let index = 0; index < this.vertexCount; index++) {
      if (this.pruned[index])
        continue;
      result.set(this.fileBytes.subarray(this.rowsStart + index * this.stride, this.rowsStart + (index + 1) * this.stride), destination);
      destination += this.stride;
    }
    result.set(suffix, destination);
    return result;
  }
  exportUnchangedBytes(): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(this.fileBytes);
    for (const [address, bytes] of this.originalValues)
      result.set(bytes, address);
    return result;
  }
  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.vertexCount)
      throw new RangeError(`Gaussian index out of range: ${index}`);
  }
}
