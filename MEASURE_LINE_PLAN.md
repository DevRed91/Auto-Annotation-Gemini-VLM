# Glowing Measurement Line — Implementation Plan

Status: **planned, not yet implemented**
Target branch: `experiment/dimension-identification`
Author: Devraj Reddy

---

## 1. Context

`SplatViewer` (`src/script.ts`) currently exposes exactly one interaction tool: the
**✏️ Annotation Tool** button, which arms a single click, ships a canvas snapshot plus the
click coordinates to Gemini, and drops a DOM pin with auto-measured dimensions.

This feature adds a second, **entirely local** tool. The user clicks two points in the
Gaussian Splat scene and we draw a neon-glowing line between them, with START / END markers
and a midpoint label. The reference is a bright blue route line drawn over a city splat.

### Requirements (confirmed)

| Aspect | Decision |
|---|---|
| Endpoint input | **Click in the 3D scene** — raycast against the `SplatMesh`. Not typed coordinates. |
| Distance text | **Typed manually by the user** into the midpoint label (e.g. `300 m`). Nothing is auto-computed, no scale calibration. |
| Scope | **Single segment first**, structured so a multi-point polyline + "Total Route" can be added later without rework. |
| Glow | **Self-contained on the line** — additive core + halo shader. No `EffectComposer` / `UnrealBloomPass`; the splat scene keeps rendering exactly as it does today. |

### Explicit non-goals

- No distance computation, no units-per-meter scale factor, no calibration workflow.
- No post-processing pipeline. (See §5 for why this is also the *safe* choice with Spark.)
- No multi-segment routes in v1 — only the data structure is made ready for them.

---

## 2. Architecture

One new self-contained module pair plus a thin integration seam in `SplatViewer`.
**Nothing in the existing Gemini annotation path changes behaviourally.**

```
src/measure/
  GlowLine.ts         # the 3D visual: Line2 + patched LineMaterial
  MeasureLineTool.ts  # state machine, picking, DOM markers & label
```

---

## 3. `src/measure/GlowLine.ts` — the 3D visual

### Base: three.js wide lines

Build on `Line2` / `LineGeometry` / `LineMaterial` from `three/examples/jsm/lines/*`.

Verified available: `node_modules/three/examples/jsm/lines/` contains `Line2.js`,
`LineGeometry.js`, `LineMaterial.js`, `LineSegments2.js`, `LineSegmentsGeometry.js`;
re-exported from `three/examples/jsm/Addons.js:72-74`; three is `0.180.0`.
`Line2`'s own docblock states it is for `WebGLRenderer` — which is what we use.

`LineMaterial` already solves the hard part: screen-space **constant pixel width** with
correct perspective expansion and rounded caps. We only need to replace its fragment output.

### The glow shader (via `onBeforeCompile`)

Patch the material rather than writing a ribbon shader from scratch.

In non-`worldUnits` mode the fragment shader carries `varying vec2 vUv`
(`LineMaterial.js:99` / `:116`), and the geometry's `uv` attribute
(`LineSegmentsGeometry.js:44`) is:

```js
const uvs = [ -1, 2,  1, 2,  -1, 1,  1, 1,  -1, -1,  1, -1,  -1, -2,  1, -2 ];
```

So **`vUv.x` spans `-1 → 1` across the line's width**, and `vUv.y` runs along the length,
exceeding `±1` only inside the two endcap regions. The stock shader already derives the
rounded-cap radius from exactly these (`LineMaterial.js:377-385`), so reuse that expression
as the glow coordinate:

```glsl
float a = vUv.x;
float b = ( abs( vUv.y ) > 1.0 ) ? ( vUv.y > 0.0 ? vUv.y - 1.0 : vUv.y + 1.0 ) : 0.0;
float r = sqrt( a * a + b * b );                  // 0 at centreline, 1 at edge, round caps

float core = smoothstep( uCoreWidth, 0.0, r );    // tight white-hot centre
float halo = exp( -uFalloff * r * r );            // smooth exponential bleed
vec3  col  = mix( uGlowColor, uCoreColor, core );
gl_FragColor = vec4( col, ( core + halo * uGlowStrength ) * uOpacity );
```

Implementation detail: inside `onBeforeCompile`, use
`shader.fragmentShader.replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );', <above>)`,
and also neutralise the hard `if ( len2 > 1.0 ) discard;` in the cap branch so the halo can
reach the quad edge. Register `uCoreWidth`, `uFalloff`, `uGlowStrength`, `uGlowColor`,
`uCoreColor`, `uOpacity`, `uTime` on `shader.uniforms` and keep references for updates.

> ⚠️ `onBeforeCompile` needs a stable `material.customProgramCacheKey()` if the defines ever
> vary. Here they don't — one material config — so the default is fine.

### Material settings

```ts
transparent: true,
blending:    THREE.AdditiveBlending,
depthWrite:  false,
depthTest:   false,     // see §5
toneMapped:  false,     // keep the core from being crushed by tone mapping
linewidth:   28,        // PIXELS — this is the halo's full width; the visible core is a fraction of it
```
and on the object: `line.renderOrder = 999`.

### Two values the owner must keep in sync

| Value | Where it must be updated |
|---|---|
| `material.resolution.set(w, h)` | `onWindowResize()` — `src/script.ts:138`. Without this the line width is wrong after a resize. |
| `uTime` | `startAnimationLoop()` — `src/script.ts:144`. Drives an optional subtle pulse / flow. |

---

## 4. `src/measure/MeasureLineTool.ts` — state + UI

- **State machine:** `idle → awaitingStart → awaitingEnd → complete`.
- Holds `points: THREE.Vector3[]` (length 2 in v1 — this array *is* the polyline seam),
  one `GlowLine`, and the DOM nodes for START / END / label.
- **Live preview:** while in `awaitingEnd`, update the line's end point on `pointermove`
  from the current hover hit, so the user sees the line stretch before committing.
- `clear()` / `reset()` to remove the line from the scene, dispose geometry + material, and
  remove the DOM nodes.

### Interaction flow

1. Click **📏 Measure Line** → tool armed, annotation tool force-deactivated, cursor `crosshair`.
2. First non-drag click → START placed (glowing pin + `START` caption).
3. Pointer move → line previews from START to the hovered point.
4. Second click → END placed, line committed, midpoint label appears with an empty editable
   field focused, placeholder `e.g. 300 m`.
5. User types the text; it renders in the pill. Clicking the label re-opens it for editing.
6. Button returns to inactive. A small `✕` on the label removes the line.

### CSS (`src/style.css`)

Follow the existing `.annotation-container` / `.annotation-pin` pattern already in the file
(`style.css`, the `.annotation-*` block). Add:

- `.measure-pin` — glowing dot, `box-shadow` halo in the line's blue.
- `.measure-caption` — the `START` / `END` text.
- `.measure-label` — pill with an editable text field.

Reuse `.toolbar-btn` / `.toolbar-btn.active` for the new button; no new button styling needed.

---

## 5. Spark / three.js interop — verified facts

These were read out of the installed bundle, not assumed.

### Splats do not write depth

`SparkRenderer` builds its splat `ShaderMaterial` at
`node_modules/@sparkjsdev/spark/dist/spark.module.js:9856-9867`:

```js
transparent: options.transparent ?? true,
depthTest:   options.depthTest   ?? true,
depthWrite:  options.depthWrite  ?? false,
```

Spark's own source comment on `depthWrite` reads: *"enabling this may produce undesirable
results because most of the Gsplat is transparent."* Even with it on, `splatVertex.glsl`
writes the **splat centre's** depth flat across the whole quad and `splatFragment.glsl` has
no `gl_FragDepth` write — so it is per-splat, not per-fragment.

**Consequences for us:**

- A `depthTest: true` line **would not be occluded by the splat anyway**, because nothing
  wrote depth. Setting `depthTest: false` is the predictable choice, not a compromise.
- All splats are **one** `THREE.Mesh` draw call, so three.js's transparent sort places the
  entire splat cloud at a single Z. A *transparent* mesh sorted against that is essentially
  always wrong. Hence `renderOrder = 999` on our line — explicit, not sort-dependent.
- Spark sets **no** `renderOrder` of its own anywhere in the bundle, so 999 is unopposed.

### Do not reuse `getDepthKernel`

`getDepthKernel` (`src/script.ts:~340`) calls
`gl.readPixels(..., gl.DEPTH_COMPONENT, gl.FLOAT, ...)`. WebGL2 rejects `DEPTH_COMPONENT`
reads on the default framebuffer, and — independently — splats never write depth, so there
would be nothing to read even if it were allowed. **The raycast path is the one that works
in this app.** This is a pre-existing issue in the Gemini sampling path; fixing it is out of
scope here, but it should not be propagated into new code.

### Raycast picking — accuracy knobs

`SplatMesh.raycast` (`spark.module.js:12716-12827`) brute-forces **every splat** through a
WASM kernel and intersects the actual per-splat Gaussian ellipsoids — no BVH, no bounding
proxy, no `Raycaster.params` threshold. It returns distances only (no face/uv/index) and
**does not sort** — but we reach it through `raycaster.intersectObject()`, which sorts for
us, so the existing `getAnnotationPosition` is correct as written.

Two tunables if click placement feels imprecise:

- **`SplatMeshOptions.minRaycastOpacity`** — default `0.2` (`spark.module.js:12210`). Raising
  it makes picking ignore faint haze splats; lowering it makes faint geometry pickable.
- **`SparkRendererOptions.lodRaycast`** — when LoD is active, `SparkRenderer` overwrites
  `SplatMesh.raycastIndices` every `lodRaycastIntervalMs` (default 500 ms) with a *decimated*
  subset: `maxSplats: Math.min(this.lodRaycast, Math.round(totalLodSplats * 0.1))`
  (`spark.module.js:10677`), i.e. ≤25 000 splats on desktop / 10 000 on mobile. If picking
  is coarse or drifts between clicks, this is the cause. Note our initial scene is a plain
  `.ply` (`src/script.ts:716`), which may have no LoD trees at all — **verify before tuning**.

### No post-processing

Grepping the whole package: **no `EffectComposer` / pass support anywhere**. Spark also
hijacks `renderer.setRenderTarget` mid-render (`spark.module.js:9542-9568`) and derives its
projection scale from `renderer.getDrawingBufferSize()` with no way to inject a render size —
so a composer whose buffers differ from the drawing buffer would mis-scale the splats.
This independently confirms the "self-glow only, no bloom" decision.

---

## 6. Changes to existing files

### `index.html`

Add a second button inside `#toolbar`:

```html
<button id="measureToolButton" class="toolbar-btn">📏 Measure Line</button>
```

### `src/script.ts` — four surgical edits

**1. Tool arbitration.**
Today `isSelecting` (`:77`) is a lone boolean and `setupClickInteraction` (`:166`)
early-returns unless it is set. Replace with
`activeTool: "none" | "annotate" | "measure"`. `setupAnnotationUI` (`:182`) sets
`"annotate"`, a new `setupMeasureUI` sets `"measure"`, and arming one clears the other —
both the state and the sibling button's `.active` class. Keeping `isSelecting` as a derived
getter is acceptable if it avoids touching every reference.

**2. Drag-vs-click gating.**
`SparkControls` calls `canvas.setPointerCapture()` on `pointerdown`
(`spark.module.js:19879`) but never suppresses the subsequent `click`. **An orbit-drag that
ends over the canvas still fires `click`.** Today that can mis-fire the annotation tool;
it would make the measure tool unusable, since every camera rotation would drop a point.

Record the `pointerdown` client position and ignore the `click` if the pointer moved more
than ~5 px. This also quietly fixes the existing annotation tool.

**3. Reuse the existing picking helper.**
`getAnnotationPosition(normalizedX, normalizedY)` (`:304`) already does
normalized → NDC → `THREE.Raycaster` → `intersectObject(this.currentSplat)` → world hit.
The measure tool calls it. **No new picking code.**

**4. Render-loop + resize hooks.**
In `startAnimationLoop()` (`:144`), beside the existing `updateAnnotationLabels()` call, add
`this.measureTool?.update(dt)` — advances `uTime` and repositions the START / END / label DOM
elements. The projection math already exists in `updateAnnotationLabels()` (`:201`):
project to NDC, hide when `pos.z > 1`, map to pixels. **Factor that into a shared
`projectToScreen(position)` helper and call it from both places** rather than duplicating it.

In `onWindowResize()` (`:138`), add `this.measureTool?.onResize(w, h)` to refresh
`material.resolution`.

---

## 7. Verification

1. `npm run dev`; let `/BiltmoreGaussianSplat.ply` load (`src/script.ts:716`).
2. **Drag gating** — with the measure tool armed, orbit via click-drag: no point should be
   placed. Confirm the same now holds for the annotation tool.
3. **Placement** — click two points on the floor/ground. Both pins land on the surface under
   the cursor, not floating, and stay locked to that surface while orbiting and moving.
4. **Glow** — the line reads as a bright core with a soft blue bleed (compare to the
   reference image), and holds a constant screen thickness as you move toward/away from it.
5. **Resize** — resize the window; line thickness must not jump.
6. **Label** — type `300 m`; it renders, sits at the segment midpoint, follows the camera,
   and hides when the segment goes behind the camera.
7. **No regression** — arm the ✏️ Annotation Tool and click an object: the Gemini round-trip,
   pin, and dimension card behave as before, and the splat scene looks identical.
8. `npx tsc --noEmit` — note `strict`, `noUnusedLocals`, and `noUnusedParameters` are all
   enabled in `tsconfig.json`.

---

## 8. Known follow-ups (deliberately deferred)

- **Polyline routes** — `points: Vector3[]` and `LineGeometry.setPositions()` already accept
  N points; the work is UI (waypoint commit, per-segment labels, a "Total Route" pill).
- **Computed distances** — if the splat is ever placed in a metric frame, the typed label can
  become a computed one with a units-per-meter factor; nothing in this design blocks it.
- **Occlusion** — if lines-behind-geometry ever need to be dimmed rather than drawn over,
  the only real option with Spark is `SparkRendererOptions.depthWrite: true`, which Spark
  itself warns against. Would need its own evaluation.
