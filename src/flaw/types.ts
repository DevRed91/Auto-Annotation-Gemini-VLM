export const FLAW_CLASSES = [
  "Floater",
  "Needle Stretch",
  "Haze",
  "Ghosting",
  "Specular Collapse",
  "Structure Missing",
  "Over-smooth",
  "HF Blur",
] as const;
export type FlawClass = (typeof FLAW_CLASSES)[number];
export interface Region {
  class: FlawClass;
  pixels: Uint8Array;
  width: number;
  height: number;
  bbox: [
    number,
    number,
    number,
    number
  ];
  centroid2D: {
    x: number;
    y: number;
  };
  confidence: number;
}
export interface DiagnosisRegion {
  class: FlawClass;
  /** Gemini box: [ymin, xmin, ymax, xmax], in 0-1000 image coordinates. */
  box: [
    number,
    number,
    number,
    number
  ];
  mask: string;
  /** Defaults to box-local; full-frame masks must opt in explicitly. */
  maskSpace?: "box" | "full-frame";
  confidence: number;
}
export interface LiftResult {
  indices: Uint32Array;
  class: FlawClass;
  detached: Uint8Array;
  /** Support vote count aligned with indices; ties use store index. */
  votes?: Uint32Array;
}
export interface EditRecord {
  indices: Uint32Array;
  property: string;
  previousValues: Float64Array;
  nextValues: Float64Array;
}
