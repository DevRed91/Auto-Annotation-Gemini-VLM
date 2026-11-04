# Flaw Diagnosis & Rectification — Implementation Plan

**Status:** Planning only — nothing implemented yet.
**Reference:** `gemini-code-1793774909984.md` (GaussFlaw / GeoCritic paper context, flaw→operation table, default parameters).

**Goal:** extend the existing click → Gemini → lift flow in `src/script.ts`. Gemini detects 3DGS **flaws** (8 GaussFlaw classes) instead of objects. Lifting selects **individual Gaussians** instead of a bounding box. The viewer then applies targeted edits (opacity, scale, SH, prune) and exports an edited PLY.

---

## 1. Findings from the current codebase

| Area | Finding | Impact |
|---|---|---|
| Lifting (`sampleCandidatesFromBox`) | Grid of raycasts inside the Gemini box → DBSCAN → `Box3` | Only partly reusable; per-Gaussian selection is needed |
| Depth (`getDepthKernel`) | `gl.readPixels(..., DEPTH_COMPONENT)` is not allowed on the WebGL2 default framebuffer | Almost certainly always falls back to raycast; don't rely on it |
| Spark 2.0 `PackedSplats` | `setSplat()` edits center/scale/rotation/opacity/colour only. SH is stored quantised in separate textures. No PLY writer | Keep our own data store; SH preview requires a reload |
| `WebGPUComputeService` | Runs on its own GPU device, separate from the WebGL renderer | Fine for per-Gaussian maths; can't read Spark render targets |
| Splat transform | Loaded with `quaternion(1,0,0,0)` and `position(0,-1.5,0)` | Every Gaussian must go through `splat.matrixWorld` before projection |
| Scene size | `City_Block.ply` ≈ 240 MB ≈ 1M Gaussians | A CPU loop per probe view is fine; WebGPU is an optional optimisation |
| Gemini backend | Lives outside this repo (`C:\Projects\Agents\gemini-test\gemini-test\server.ts`); returns `{label, box}` | Needs a new endpoint returning masks + flaw class |

---

## 2. Proposed file layout

```
src/flaw/
├── types.ts              FlawClass enum, Region, LiftResult, EditRecord
├── GaussianStore.ts      M0 – binary PLY parse/serialise, raw-space edits
├── diagnosisClient.ts    M1 – POST /api/diagnose
├── regions.ts            M2 – mask decode, threshold, connected components
├── probeViews.ts         M3 – probe camera generation
├── lift.ts               M3 – per-Gaussian visibility / depth / support voting
├── highlight.ts          M4 – selection preview via setSplat recolour
├── rectify.ts            M5 – decision table, budgets, undo stack
├── preview.ts            M6 – live Spark updates, SH reload
├── exportPly.ts          M7 – PLY download (+ optional GaussFlaw annotations)
└── FlawTool.ts           UI tool wiring (like MeasureLineTool)
```

`script.ts` gets a third tool mode, `"diagnose"`, alongside `"annotate"` and `"measure"`.

---

## 3. Milestones

### M0 — Gaussian store (`GaussianStore.ts`)
- Write a small binary PLY parser that keeps the raw property buffer byte-for-byte: `x y z`, `scale_0..2` (log), `rot_0..3`, `opacity` (logit), `f_dc_0..2`, `f_rest_0..44`.
- Keep per-property offsets into the stride so edits are in-place reads/writes on a `DataView`.
- The store is the **source of truth**. Spark is only the renderer.
- Keep a map from store index to Spark splat index. Turn LOD **off** while editing (`lod: false`).
- Supported input: PLY only. `.sog` is out of scope (see open questions).

### M1 — Diagnosis API
- **Backend (separate repo):** a new `POST /api/diagnose`.
  - Request: `{ image: dataURL, click?: {x, y} }`
  - Response: `[{ class: FlawClass, box: [xmin,ymin,xmax,ymax], mask: base64 PNG, confidence: number }]`
  - The prompt includes the 8 class definitions from the context doc and asks for segmentation masks. This needs a Gemini model that supports masks (2.5+).
- **Frontend:** `diagnosisClient.ts` reuses `captureSnapshot()` and `buildAnnotateEndpoint`-style URL handling.
- Show the masks as a 2D canvas overlay, coloured per class, with accept/reject per region.

### M2 — Region selection (`regions.ts`)
- Decode each mask into a `Uint8Array` at canvas resolution.
- Threshold it (default 0.5). Gemini masks are binary, so this only cleans anti-aliased edges.
- Label connected components (two-pass union-find) and drop those under 64 px.
- Output: `Region { class, pixels, bbox, centroid2D }`.

### M3 — Region lifting (`probeViews.ts`, `lift.ts`)
1. **Probe views.** The annotating camera is always view 0. Add N−1 more (default N = 8) on a cone of ±25° around the camera → region-centroid axis, at the same distance.
   - If training cameras are available, use those instead (see open questions).
2. **Surface depth per view.** Raycast a coarse grid over the projected region bbox and interpolate between samples.
   - Later: depth render via `SparkRenderer.renderTarget` + a depth-encoding modifier.
3. **Per-Gaussian tests** for each view, using world-space centres via `matrixWorld`:
   - **visible:** projects inside the region mask and `z_g ≤ z_surf·(1 + 0.02)`
   - **foreground outlier:** `z_g < z_surf·(1 − 0.05)`
   - **surface support:** at least 3 neighbours within 2× own scale that pass the depth check (spatial hash grid)
4. **Vote:** a Gaussian is selected if it passes in at least 60% of the views where it is visible. `detached = outlier && !supported` across the majority of views.
5. **Output:** `LiftResult { indices: Uint32Array, class, detached: Uint8Array }`.
6. **Optimisation (only if profiling demands it):** move the projection and tests to WGSL in `WebGPUComputeService` (new pass names `projectGaussians` and `regionVote`).

### M4 — Selection preview (`highlight.ts`)
- Recolour selected splats neon yellow `(1.0, 0.95, 0.0)` via `packedSplats.setSplat`, then set `needsUpdate = true`.
- Restore original colours from the store on clear.
- UI panel: selected count per class and planned operation per class, shown before anything is applied.

### M5 — Operations (`rectify.ts`)
- Apply the decision table from the context doc, in raw PLY space:

| Class | Condition | Edit |
|---|---|---|
| Floater / Needle Stretch | detached | prune |
| Floater, Haze, Ghosting | non-detached | `o = logit(0.65·sigmoid(o))` |
| Needle Stretch | non-detached | `log_s[argmax] += ln(0.75)` |
| Ghosting (anisotropic, `s_max/s_mid > 3`) | — | `log_s[argmax] += ln(0.90)` |
| Specular Collapse | — | `f_rest_* *= 0.70` |
| Structure Missing / Over-smooth / HF Blur | — | flag only (densification out of scope) |

- **Conflict priority:** prune > scale > opacity > SH. Each distinct operation is applied at most once per Gaussian per pass.
- **Pruning budget:** at most 2% of all Gaussians per pass. If over budget, prune the most-voted Gaussians first.
- **Undo stack:** each `EditRecord` holds `{indices, property, previousValues}`, supporting undo/redo.

### M6 — Live preview (`preview.ts`)
- Opacity and scale: `setSplat` with activated values from the store, then `needsUpdate = true`.
- Pruned splats: opacity 0 in the preview; really deleted only at export.
- SH: `setSplat` can't edit it. An explicit **"Refresh preview"** action serialises the store and rebuilds the `SplatMesh` from `fileBytes`. It's slow, which is why it isn't automatic.

### M7 — Export (`exportPly.ts`)
- Write the original header, with the updated vertex count, plus the edited buffer, leaving out pruned rows. Download it as `<scene>_rectified.ply`.
- Optional: export annotations in GaussFlaw format (per view: region mask PNG + class label JSON) for evaluation.

---

## 4. Suggested order

1. M0 store + round-trip test (load → export unchanged → byte-identical).
2. M1 diagnose endpoint + overlay.
3. M2 regions.
4. M3 lifting, **annotating view only** (N = 1).
5. M4 highlight.
6. M5/M6, opacity + prune only.
   - **First demo:** click a floater → it is highlighted → apply → it disappears.
7. M3 multi-view probes.
8. Scale edits, then SH edits + reload preview.
9. M7 export.
10. WebGPU optimisation, if needed.

---

## 5. Testing & validation

- **PLY round-trip:** export with no edits must be byte-identical to the input.
- **Edit maths:** unit-test logit/log-space formulas, e.g. `sigmoid(edited) ≈ 0.65·sigmoid(orig)`.
- **Lifting sanity:** on a synthetic scene (a plane plus a known floating cluster), the lift must select the cluster and not the plane.
- **Visual:** before/after screenshots from fixed camera poses, plus a toggle to compare original and edited.
- **Performance:** time lifting per view on `City_Block.ply` (~1M Gaussians). Target < 200 ms per view on the CPU.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Synthetic orbit probes see floaters poorly | Use training cameras if available; let the user add probe views manually |
| Gemini masks are imprecise or classes are wrong | Accept/reject per region before lifting; show the class and allow relabelling |
| Raycast surface depth is slow or noisy | Coarse grid + interpolation; later a depth render target |
| Spark index ≠ store index (LOD, reordering) | Disable LOD in edit mode; verify the mapping on load |
| Memory: raw buffer + Spark copy of ~1M splats | ~240 MB raw + Spark textures; acceptable on desktop, warn on mobile |

---

## 7. Open questions

**For the user (these change the design):**
1. **Training cameras:** are COLMAP `cameras.bin`/`images.bin` or `transforms.json` available for the scenes? They decide whether M3 uses real probe views or synthetic orbit views.
2. **Backend:** can `server.ts` in the separate repo be modified? Which Gemini model and SDK version does it use? Mask support depends on the model.
3. **Interaction:** click a flaw to diagnose it, or "scan this view" for all flaws?
4. **Applying edits:** require user confirmation for every edit, or auto-apply with undo?
5. **Formats:** must `.sog` scenes be editable, or is PLY enough? SOG is quantised; round-tripping it is lossy and needs a separate writer.
6. **Deliverable:** edited PLY, a GaussFlaw-style annotation dataset, or both?

**From the paper (unlikely to be resolved; defaults from the context doc stand):**
- The detection rule for "anisotropic ghosting".
- The exact "surface support" test and the pruning budget.
- Whether GeoCritic weights are released. If they are, they could replace or cross-check Gemini; Gemini only gives binary masks, with no continuous saliency.
