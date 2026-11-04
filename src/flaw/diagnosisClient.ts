import { FLAW_CLASSES, type DiagnosisRegion } from "./types";
export function buildDiagnoseEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/diagnose"))
    return normalized;
  if (normalized.endsWith("/api"))
    return `${normalized}/diagnose`;
  return normalized.startsWith("http") ? `${normalized}/api/diagnose` : `${normalized}/diagnose`;
}
export async function diagnose(endpoint: string, image: string, click: {
  x: number;
  y: number;
}, bypassTunnel = false): Promise<DiagnosisRegion[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bypassTunnel)
    headers["bypass-tunnel-reminder"] = "true";
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ image, click }) });
  if (!response.ok) {
    const body = await response.text();
    let detail = "";
    try {
      const error = JSON.parse(body);
      detail = [error?.error, error?.details, error?.message]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join(": ");
    } catch {
      // Proxy responses may be plain text or HTML. Never display an HTML error page.
      if (!body.trimStart().startsWith("<")) detail = body.trim().slice(0, 500);
    }
    if (!detail && response.status === 502)
      detail = "The API gateway could not complete the diagnosis request. Check that the backend on localhost:3000 is running and inspect its logs.";
    if (!detail && response.status === 404)
      detail = "The backend does not expose POST /api/diagnose. Start a backend that implements the diagnosis endpoint.";
    throw new Error(`Diagnosis request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const payload: unknown = await response.json();
  const rows = Array.isArray(payload) ? payload : (payload as {
    regions?: unknown;
  })?.regions;
  if (!Array.isArray(rows))
    throw new Error("Diagnosis response did not contain regions");
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object")
      return [];
    const item = row as Partial<DiagnosisRegion>;
    if (!FLAW_CLASSES.includes(item.class!) || typeof item.mask !== "string" || !item.mask ||
      !Array.isArray(item.box) || item.box.length !== 4 ||
      !item.box.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000) ||
      item.box[0] >= item.box[2] || item.box[1] >= item.box[3] ||
      (item.maskSpace !== undefined && item.maskSpace !== "box" && item.maskSpace !== "full-frame"))
      return [];
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence)) : 0;
    return [{ class: item.class!, mask: item.mask, box: item.box, maskSpace: item.maskSpace ?? "box", confidence }];
  });
}
