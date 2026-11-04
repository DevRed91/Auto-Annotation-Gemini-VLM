import type { DiagnosisRegion, Region } from "./types";
function decodeBase64(value: string): Uint8Array {
  const payload = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** Converts a mask image into connected components at the supplied canvas size. */
export async function decodeRegions(detections: DiagnosisRegion[], width: number, height: number, minPixels = 64, threshold = 0.5): Promise<Region[]> {
  const result: Region[] = [];
  for (const detection of detections) {
    const image = new Image();
    image.src = detection.mask.startsWith("data:") ? detection.mask : `data:image/png;base64,${detection.mask}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context)
      continue;
    if (detection.maskSpace === "full-frame") {
      context.drawImage(image, 0, 0, width, height);
    }
    else {
      const [ymin, xmin, ymax, xmax] = detection.box;
      context.drawImage(image, xmin * width / 1000, ymin * height / 1000, (xmax - xmin) * width / 1000, (ymax - ymin) * height / 1000);
    }
    const rgba = context.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      const alpha = rgba[i * 4 + 3] / 255;
      const value = alpha < 0.99 ? alpha : (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / (3 * 255);
      mask[i] = value >= threshold ? 1 : 0;
    }
    const visited = new Uint8Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || visited[start])
        continue;
      const queue = [start];
      visited[start] = 1;
      const pixels: number[] = [];
      let minX = width, minY = height, maxX = 0, maxY = 0, sumX = 0, sumY = 0;
      while (queue.length) {
        const current = queue.pop()!;
        pixels.push(current);
        const x = current % width;
        const y = Math.floor(current / width);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        sumX += x;
        sumY += y;
        for (const next of [current - 1, current + 1, current - width, current + width]) {
          if (next < 0 || next >= mask.length || visited[next] || !mask[next])
            continue;
          if (Math.abs((next % width) - x) + Math.abs(Math.floor(next / width) - y) !== 1)
            continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      if (pixels.length < minPixels)
        continue;
      const component = new Uint8Array(width * height);
      pixels.forEach((pixel) => component[pixel] = 1);
      result.push({ class: detection.class, pixels: component, width, height, bbox: [minX / width, minY / height, (maxX + 1) / width, (maxY + 1) / height], centroid2D: { x: sumX / pixels.length / width, y: sumY / pixels.length / height }, confidence: detection.confidence });
    }
  }
  return result;
}
export function maskFromPixels(region: Region, x: number, y: number): boolean { const px = Math.round(x * (region.width - 1)); const py = Math.round(y * (region.height - 1)); return region.pixels[py * region.width + px] === 1; }
// Kept as a small explicit helper for tests and callers that already have raw PNG bytes.
export { decodeBase64 };
