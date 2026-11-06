import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyQualityProfile,
  getDeviceTier,
  MAX_SCREEN_RADIUS,
  patchSplatClampingShader,
} from "../src/utils/splatQuality.ts";

// Exercise the actual pinned shader, so upstream layout changes fail this check.
const sparkSource = await readFile(
  new URL("../node_modules/@sparkjsdev/spark/dist/spark.module.js", import.meta.url), "utf8",
);
const shader = JSON.parse(sparkSource.match(/var splatVertex_default = (".*");/)[1]);

test("device profiles reserve low for limited mobile, then mobile, then desktop capacity", () => {
  const cases = [
    [{ mobile: true, cores: 4, memoryGB: 8 }, "low"],
    [{ mobile: true, cores: 16, memoryGB: 4 }, "low"],
    [{ mobile: false, cores: 4, memoryGB: 4 }, "mid"],
    [{ mobile: false, cores: 16, memoryGB: 4 }, "mid"],
    [{ mobile: true, cores: 8, memoryGB: 8 }, "mobile"],
    [{ mobile: false, cores: 8, memoryGB: 8, pixelRatio: 2 }, "high"],
    [{ mobile: false, cores: 8, pixelRatio: 3 }, "mid"],
    [{ mobile: false, cores: 6, memoryGB: 8 }, "mid"],
    [{ mobile: false }, "mid"],
    [{ mobile: false, cores: 0, memoryGB: 0 }, "mid"],
  ];
  for (const [hints, expected] of cases) assert.equal(getDeviceTier(hints), expected);
});

test("patch accepts the installed Spark shader and preserves its disabled path", () => {
  const patched = patchSplatClampingShader(shader);
  assert.match(patched, /uniform float uClampMaxScreenRadius;/);
  assert.match(patched, /uniform bool uClampActive;/);
  assert.doesNotMatch(patched, /uClampFadeRange|smoothstep/);
  assert.match(patched, /float scale1;[\s\S]*else \{[\s\S]*scale1 = min\(maxPixelRadius,/);
  // Both branches must assign the outer variables consumed by pixelOffset.
  assert.doesNotMatch(patched, /float scale[12] =/);
});

test("shader patch rejects missing, duplicate, and already patched anchors", () => {
  assert.throws(() => patchSplatClampingShader("void main() {}"), /Spark 2.0.0/);
  assert.throws(() => patchSplatClampingShader(shader.replace("sqrt(eigen1)", "sqrt(eigen1 + 0.1)")), /anchor/);
  assert.throws(() => patchSplatClampingShader(shader + "\nuniform float maxPixelRadius;"), /anchor/);
  assert.throws(() => patchSplatClampingShader(patchSplatClampingShader(shader)), /anchor/);
});

function rendererStub() {
  return {
    maxPixelRadius: 512,
    material: { vertexShader: shader, uniforms: {}, needsUpdate: false },
  };
}

test("each profile installs its radius and fade uniforms", () => {
  for (const [tier, radius] of Object.entries(MAX_SCREEN_RADIUS)) {
    const spark = rendererStub();
    const quality = applyQualityProfile(spark, tier);
    assert.equal(quality.tier, tier);
    assert.equal(spark.maxPixelRadius, radius);
    assert.equal(spark.material.uniforms.uClampMaxScreenRadius.value, radius);
    assert.equal(spark.material.uniforms.uClampFadeRange, undefined);
    assert.equal(spark.material.needsUpdate, true);
  }
});

test("toggle restores 512, bypasses clamp, and remembers radius changes while disabled", () => {
  const spark = rendererStub();
  const quality = applyQualityProfile(spark, "mid");
  quality.setMaxScreenRadius(80);
  assert.equal(spark.maxPixelRadius, 80);
  quality.setClampingActive(false);
  assert.equal(spark.maxPixelRadius, 512);
  assert.equal(spark.material.uniforms.uClampActive.value, false);
  quality.setMaxScreenRadius(96);
  assert.equal(spark.maxPixelRadius, 512);
  assert.equal(quality.maxScreenRadius, 96);
  quality.setClampingActive(true);
  assert.equal(quality.clampingActive, true);
  assert.equal(spark.maxPixelRadius, 96);
  assert.equal(spark.material.uniforms.uClampMaxScreenRadius.value, 96);
});

test("invalid radius changes leave renderer state intact", () => {
  const spark = rendererStub();
  const quality = applyQualityProfile(spark, "high");
  for (const px of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => quality.setMaxScreenRadius(px), RangeError);
    assert.equal(spark.maxPixelRadius, 128);
    assert.equal(quality.maxScreenRadius, 128);
  }
});

test("incompatible shaders fail without modifying the renderer", () => {
  const spark = rendererStub();
  spark.material.vertexShader = "void main() {}";
  assert.throws(() => applyQualityProfile(spark, "low"), /anchor/);
  assert.equal(spark.maxPixelRadius, 512);
  assert.deepEqual(spark.material.uniforms, {});
  assert.equal(spark.material.needsUpdate, false);
});
