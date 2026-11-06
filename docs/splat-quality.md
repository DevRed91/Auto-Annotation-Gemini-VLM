# Splat radius controls

## Summary

Large splats near the camera are expensive to fill and, if clamped naively,
make close surfaces vanish. This module adds a per-device-tier screen-radius
cap that can be toggled at runtime. The cap is implemented as a patch to Spark's
vertex shader and is **disabled by default** in `SplatViewer`, so close-up
rendering is identical to stock Spark unless clamping is turned on.

## Benefits for splats near the camera

- **No disappearing surfaces.** Oversized splats are shrunk proportionally on
  both axes and never alpha-faded, so walls and facades stay solid as the
  camera approaches.
- **Stock close-up quality by default.** `script.ts` calls
  `setClampingActive(false)` at startup. This restores Spark's original
  per-axis 512 px clamp and the unmodified shader path.
- **Opt-in performance trade-off.** Devices that cannot afford the fill cost
  of huge splats can enable the clamp with a tier-appropriate radius.
- **Live A/B comparison.** Radius and toggle can be changed from the dev
  console at a fixed camera position, with no rebuild.

Limitation: when clamping is on, shrinking can make large nearby surfaces look
blotchy. Tune per scene.

## How it works

`applyQualityProfile(spark, tier)` (`src/utils/splatQuality.ts`) runs once,
before the first render. It patches `spark.material.vertexShader`, registers
the uniforms `uClampMaxScreenRadius` and `uClampActive`, and sets
`spark.maxPixelRadius`. It starts with clamping active; `SplatViewer` then
disables it immediately.

| State | `uClampActive` | `spark.maxPixelRadius` | Shader behavior |
| --- | --- | --- | --- |
| Enabled | `true` | current radius (tier default or last `setMaxScreenRadius`) | proportional shrink of both axes to fit the radius |
| Disabled | `false` | 512 (`DEFAULT_MAX_PIXEL_RADIUS`) | Spark's original per-axis `min(maxPixelRadius, ...)` |

`setMaxScreenRadius(px)` throws `RangeError` unless `px` is finite and
positive. While clamping is disabled it only stores the value; it is applied
when clamping is re-enabled.

## Files

| File | Role |
| --- | --- |
| `src/utils/splatQuality.ts` | tier detection, shader patch, `applyQualityProfile`, `SplatQualityControls` |
| `src/script.ts` | creates `SparkRenderer` with the tier radius, applies the profile, disables clamping, exposes `setMaxScreenRadius` / `setClampingActive` on `SplatViewer` |
| `src/vite-env.d.ts` | Vite client types and the `window.__splatQuality` typing |
| `tests/splatQuality.test.mjs` | tier selection, shader patch anchors, uniforms, toggle and error handling |
| `package.json` | `@sparkjsdev/spark` pinned to exactly `2.0.0` (was `^2.0.0`) |

`window.__splatQuality` is only assigned when `import.meta.env.DEV` is true.

## Details

Spark is pinned to 2.0.0 because `src/utils/splatQuality.ts` patches its render
vertex shader before the first render. Both replacement anchors must occur
exactly once; incompatible shaders fail at startup. When upgrading Spark, review
the projection and opacity code and run the shader compatibility tests.

Profiles use render pixels (CSS pixels multiplied by the renderer's pixel ratio):
low 32, mobile 48, mid 64, high 128. Mobile devices reporting at most four cores or 4 GB
of memory use low; other mobile devices use mobile. Desktop devices with at
least eight cores, at least 8 GB if memory is reported, and DPR at most two use
high. Remaining devices, including 4-core desktops, use mid. These hints are heuristics rather than GPU
measurements. `maxStdDev` retains Spark's default.

The patch computes projected radii before Spark's built-in per-axis clamp,
and shrinks both axes proportionally to fit the limit. There is no alpha fade:
oversized splats are shrunk but never made transparent, so nearby surfaces do not
vanish. Shrinking can still make large nearby surfaces look blotchy, so visual
tuning is necessary for each scene.

`SplatViewer.setMaxScreenRadius(px)` accepts finite positive render-pixel radii.
`SplatViewer.setClampingActive(false)` bypasses the clamp and restores Spark's
original per-axis 512 px clamp. Re-enabling restores the last configured radius.
The controls are also available in the development console:

```js
window.__splatQuality.tier
window.__splatQuality.setMaxScreenRadius(64)
window.__splatQuality.setClampingActive(false)
window.__splatQuality.setClampingActive(true)
```

Hover tint remains independent: object-space modifiers execute during splat
generation; this patch operates during render projection. They cannot share a
dyno block. The patch uses `uClamp*` names and leaves `objectModifier` untouched.
It covers the standard projected 3D Gaussian path used by this viewer; Spark's
optional `enable2DGS` path returns earlier and is not covered.

Run `node --experimental-strip-types --test tests/splatQuality.test.mjs` on
Node 22.19 or later, plus `npm run build` and `npx tsc --noEmit`.
For visual review, use `Apartment.sog` and `City_Block.ply`, approach building
facades, and compare clamping enabled/disabled with the same camera position.
Check at DPR 1 and 2. Tests check shader compatibility and control state;
they do not compile GLSL or replace browser validation.
