# Hover Tint Implementation (Spark.js 2.0)

Zero-extra-draw-call highlighting of the splats inside a hovered apartment box.

- Files: `src/utils/hoverTint.ts` (core), `src/script.ts` (wiring)
- Stack: Spark.js 2.0.0, three 0.180, Vite, TypeScript

## 1. Idea

1. On `pointermove`, run a CPU ray-vs-OBB test against registered apartment boxes. There is no GPU picking.
2. Pass the hovered box's transform and half-extents to the splat shader as uniforms.
3. In a Spark `objectModifier`, test each splat center against the box. Splats inside get their color mixed toward a tint.

The tint is applied during Spark's splat generation pass, so it adds no extra meshes, draw calls or overdraw.

## 2. Differences from the original spec

| Spec (`spark_js_hover_tint_implementation_context.md`) | Actual Spark 2.0 implementation |
|---|---|
| `material.setUniform(...)` | Does not exist. Use `dyno.dynoMat4/dynoVec3/dynoFloat` uniforms. |
| Edit the vertex shader | Use `SplatMesh.objectModifier` with `dyno.dynoBlock` and a custom `dyno.Dyno` (GLSL `statements`). |
| `smoothstep(0.0, -0.05, d)` | Edges reversed, which is undefined in GLSL. Use `1.0 - smoothstep(-feather, 0.0, d)`. |
| Box size from scale | World-unit `size` = geometry size x abs(world scale). |

## 3. Components (`src/utils/hoverTint.ts`)

### `OBB`
- Holds `position`, `quaternion` and `size` (full size in world units). Scale is not baked into the matrix, so the feather distance stays in world units.
- `syncFromObject3D(obj, geometrySize)` decomposes `matrixWorld` and sets `size = geometrySize * abs(scale)`.
  - `abs` is required. A mirrored object (negative scale) gives a negative half-extent, and both the shader and ray tests then always fail.
- `halfExtents` is `size / 2`.
- `getWorldMatrix()` composes a rigid matrix (position + quaternion, scale 1).

### `rayIntersectsOBB(ray, obb)` / `pickNearestOBB(ray, items)`
- Slab method in box-local space: transform the ray by `inverse(boxWorld)`, then intersect against `±halfExtents` per axis.
- Returns the hit distance or `null`. `pickNearestOBB` returns the closest hit, so overlapping units pick the nearest.

### `HoverTint`
Uniforms: `splatToBox` (mat4), `halfExtents` (vec3), `color` (vec3, default 0.2/0.9/0.6), `active` (float), `strength` (0.45) and `feather` (0.05).

`install()` sets `splat.objectModifier` and calls `updateGenerator()`. The modifier shader:

```glsl
out = in;
if (active > 0.5) {
  vec3 hvLocalPos = (splatToBox * vec4(in.center, 1.0)).xyz;
  vec3 hvD = abs(hvLocalPos) - halfExtents;
  if (hvD.x <= 0.0 && hvD.y <= 0.0 && hvD.z <= 0.0) {
    float hvEdge = max(hvD.x, max(hvD.y, hvD.z));
    float hvMask = 1.0 - smoothstep(-max(feather, 1e-5), 0.0, hvEdge);
    out.rgba.rgb = mix(in.rgba.rgb, color, strength * hvMask);
  }
}
```

- Object modifiers run in splat-local space. The matrix is therefore `inverse(boxWorld) * splat.matrixWorld`, which takes a splat-local point into box-local space.
- Locals use an `hv` prefix because Spark places statements into one shared function, and names could clash with other modifiers.

Methods:
- `setHovered(obb | null)` sets `active`, refreshes the uniforms and calls `splat.updateVersion()`.
- `refresh()` recomputes `splatToBox` and `halfExtents`.
- `setColor(r, g, b)` changes the tint color.

After uniform changes, `updateVersion()` makes Spark regenerate the splats.

## 4. Wiring (`src/script.ts`)

- State: `hoverTint`, `apartments` (id, obb, object, geometry size), `hoveredApartment` and `hoverRaycaster`.
- `loadWorld` creates `new HoverTint(splat)` after the splat is loaded. The splat transform is `quaternion (1,0,0,0)`, `position (0,-1.5,0)`.
- `registerApartment(id, object3D, geometrySize)` builds an OBB. The demo registers the cube as `demo-cube` with geometry `(0.13, 1, 0.1)`.
- `syncApartmentOBBs()` runs each frame so the OBB follows the `TransformControls` gizmo. If the hovered OBB's matrix or size changed, it calls `refresh()` and `updateVersion()`. The change check avoids regenerating every frame.
- `pointermove`:
  - Skips if `transformControls.dragging` or `hoverTint` is null.
  - Builds NDC coordinates and a ray from the camera, then calls `pickNearestOBB`.
  - Returns early if the hit id is unchanged. Otherwise it sets `hoveredApartment`, logs `[hover]` and calls `hoverTint.setHovered`.
- `pointerleave` clears the hover.

## 5. Gotchas

- `SplatMesh` has a single `objectModifier` slot. `setupSplatModifier` in `src/utils/utils.ts` uses the same slot, and it is currently commented out. Re-enabling it replaces the hover tint. To combine them, chain both in one `dynoBlock`.
- The demo cube has negative X scale (`-2.81`). That is why the `abs()` fix matters.
- The cube material has opacity 0. Hover works because the ray test uses the OBB, not the mesh.
- A high-count splat scene re-runs the generator on each hover change. That is cheap compared with extra draw calls, but avoid calling `updateVersion()` every frame.

## 6. Debugging checklist

If the tint is not visible:
1. Hover the cube and look for `[hover] demo-cube` in the console.
   - No log: the pick is failing. Check that `hoverTint` is non-null (splat loaded), that pointer events reach the canvas, and the OBB world position and size.
   - Log appears but no tint: check for shader compile errors. Temporarily raise `strength` to 1 and use a bright `color`. Confirm `updateVersion()` is called.
2. Make sure `setupSplatModifier` is not overriding the modifier.
3. Confirm the box actually overlaps splats. The splat is offset by `(0, -1.5, 0)` and rotated, and `splatToBox` accounts for that.

Status: the code type-checks (only pre-existing `tsc` errors remain). It has not been verified in a browser.
