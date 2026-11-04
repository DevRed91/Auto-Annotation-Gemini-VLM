import { GaussianStore } from "./GaussianStore";
export function downloadRectifiedPly(store: GaussianStore, sceneName = "scene"): void {
  const blob = new Blob([store.exportBytes()], { type: "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${sceneName.replace(/\.ply$/i, "")}_rectified.ply`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
