import type { SparkRenderer } from "@sparkjsdev/spark";
import { isMobileDevice } from "./mobileJoystick.ts";

export type DeviceTier = "low" | "mobile" | "mid" | "high";

export const MAX_SCREEN_RADIUS: Readonly<Record<DeviceTier, number>> = {
  low: 32,
  mobile: 48,
  mid: 64,
  high: 128,
};
const DEFAULT_MAX_PIXEL_RADIUS = 512;

interface DeviceHints {
  mobile: boolean;
  cores?: number;
  memoryGB?: number;
  pixelRatio?: number;
}

/** Capability hints are a conservative heuristic, not a GPU benchmark. */
export function getDeviceTier(hints?: DeviceHints): DeviceTier {
  const { mobile, cores, memoryGB, pixelRatio = 1 } = hints ?? {
    mobile: isMobileDevice(),
    cores: navigator.hardwareConcurrency,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    pixelRatio: window.devicePixelRatio,
  };
  const limited = (value: number | undefined, limit: number) =>
    value !== undefined && value > 0 && value <= limit;
  // "low" is for weak phones/tablets only; 4-core desktops and laptops are common and capable.
  if (mobile) return limited(cores, 4) || limited(memoryGB, 4) ? "low" : "mobile";
  // Missing capability hints default to mid. High DPR increases fill cost.
  if ((cores ?? 0) >= 8 && (memoryGB === undefined || memoryGB >= 8) && pixelRatio <= 2) {
    return "high";
  }
  return "mid";
}

const UNIFORM_ANCHOR = "uniform float maxPixelRadius;";
const SCALE_ANCHOR =
  "    float scale1 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen1));\n" +
  "    float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));";

/** Spark 2.0.0 render shader only. Fail before rendering if its layout changes. */
export function patchSplatClampingShader(source: string): string {
  if (source.includes("uClampActive")) {
    throw new Error("Splat clamping shader anchor is already patched or uses reserved uClamp names.");
  }
  for (const anchor of [UNIFORM_ANCHOR, SCALE_ANCHOR]) {
    if (source.split(anchor).length !== 2) {
      throw new Error("Splat clamping requires the Spark 2.0.0 vertex shader: missing or duplicate anchor.");
    }
  }
  return source
    .replace(UNIFORM_ANCHOR, `${UNIFORM_ANCHOR}
uniform float uClampMaxScreenRadius;
uniform bool uClampActive;`)
    .replace(SCALE_ANCHOR, `    float scale1;
    float scale2;
    if (uClampActive) {
        // Measure before Spark's per-axis clamp; shrink proportionally, no alpha fade.
        vec2 clampRadii = adjustedStdDev * sqrt(max(vec2(eigen1, eigen2), vec2(0.0)));
        float clampCurrentRadius = max(clampRadii.x, clampRadii.y);
        float clampRatio = min(1.0, uClampMaxScreenRadius / max(clampCurrentRadius, 0.000001));
        clampRadii *= clampRatio;
        scale1 = clampRadii.x;
        scale2 = clampRadii.y;
    } else {
        // Preserve Spark's original behavior when clamping is disabled.
${SCALE_ANCHOR.replaceAll("float scale", "scale")}
    }`);
}

export interface SplatQualityControls {
  readonly tier: DeviceTier;
  /** Radius in render pixels, including the renderer's pixel ratio. */
  readonly maxScreenRadius: number;
  readonly clampingActive: boolean;
  setMaxScreenRadius(px: number): void;
  setClampingActive(active: boolean): void;
}

/** Install before first render. Independent of objectModifier (e.g. hover tint). */
export function applyQualityProfile(spark: SparkRenderer, tier: DeviceTier): SplatQualityControls {
  const material = spark.material;
  const shader = patchSplatClampingShader(material.vertexShader);
  const radius = { value: MAX_SCREEN_RADIUS[tier] };
  const active = { value: true };
  Object.assign(material.uniforms, {
    uClampMaxScreenRadius: radius,
    uClampActive: active,
  });
  material.vertexShader = shader;
  material.needsUpdate = true;
  spark.maxPixelRadius = radius.value;

  return {
    tier,
    get maxScreenRadius() { return radius.value; },
    get clampingActive() { return active.value; },
    setMaxScreenRadius(px) {
      if (!Number.isFinite(px) || px <= 0) {
        throw new RangeError("Max screen radius must be a finite positive number.");
      }
      radius.value = px;
      if (active.value) spark.maxPixelRadius = px;
    },
    setClampingActive(enabled) {
      active.value = enabled;
      spark.maxPixelRadius = enabled ? radius.value : DEFAULT_MAX_PIXEL_RADIUS;
    },
  };
}
