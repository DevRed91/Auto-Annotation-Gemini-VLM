# Phase 2 — Gaussian Index Lifting Investigation

Status: **implemented and browser-validated for non-LOD, non-paged `SplatMesh` inputs.**
Run date: 2026-11-07. Final result: **21 recorded entries, 0 failed** (20 assertion tests plus one informational record, `shader reference changed-pixel count`, which asserts nothing and is not counted as a check). Raw output: [`phase2-results.json`](./phase2-results.json).

## Scope

Phase 2 adds an isolated CPU lifter from an existing world-space OBB to storage indices, and an independent R8UI mask renderer. It does not fit OBBs, perform PCA, associate covariance, infer semantic ownership, integrate Gemini, or implement production click-to-highlight. Phase 1 `HoverTint` remains available as the OBB fallback.

Files:

- `src/utils/clusterLifter.ts`: `ClusterLiftOptions`, `ClusterLiftDiagnostics`, `ClusterLiftResult`, and `liftCluster()`.
- `src/utils/gaussianIndexSupport.ts`: shared non-LOD/non-paged input guard (`assertNonLodSplat`).
- `src/utils/gaussianMaskManager.ts`: asynchronous `GaussianMaskManager.create()`, `replace()`, `clear()`, and `dispose()`.
- `src/utils/hoverTint.ts`: appends through `objectModifiers` instead of replacing the singular modifier slot.
- `phase2.html`, `src/experiment/phase2Harness.ts`, `scripts/phase2-validate.mjs`: isolated validation harness and runner.
- `docs/phase2-results.json`: final machine-readable run.

The Phase 0 files `probe.html`, `src/experiment/harness.ts`, and `src/experiment/gaussianIdProbe.ts` were not changed.

## Source-verified findings

These findings come from the installed `@sparkjsdev/spark` **2.0.0** package, not from the browser run:

1. `SplatMesh.initialized` must resolve before `numSplats` and source iteration are used (`dist/types/SplatMesh.d.ts`).
2. `forEachSplat(callback)` supplies `(index, center, scales, quaternion, opacity, color)`. Spark documents that callback objects are reused, so the lifter immediately copies the centre and scalar opacity.
3. Object modifiers execute in splat-local space. The CPU equivalent of the existing shader transform is `inverse(obbWorld) * splat.matrixWorld` applied to each local centre.
4. `objectModifiers` is an ordered array. Spark chains its entries; assigning the singular `objectModifier` replaces that array with one entry.
5. `Gsplat.index` is available to object modifiers. Its agreement with the CPU `forEachSplat` storage index is **not** a source finding; it is established empirically by the layout test below (IDs on both sides of the 4096-row boundaries).
6. `SplatGenerator.updateVersion()` increments `version`; `updateGenerator()` marks the generator dirty. The mask manager uses the former only for actual membership changes and the latter when installing/removing its modifier.
7. Phase 0 established the custom `dynoUsampler2D` path and R8UI `DataTexture` lookup. Phase 2 retains its 4096-wide layout: `x = index & 4095`, `y = index >> 12`.
8. Spark decides LOD rendering from `packedSplats.lodSplats ?? extSplats.lodSplats` being present (plus `enableLod !== false`), not from `enableLod`. A real pre-built LOD asset (`Apartment-lod.rad`) was observed to expose **only** `packedSplats.lodSplats` (`enableLod` unset, `packedSplats.lod` unset, `paged` false), so the guard keys on `lodSplats`.
9. Spark stores opacity as a byte and decodes it as `byte/255`; fixture opacity `0.5` reads back as `128/255 = 0.50196`.

## Implementation behaviour

### Lifting

`liftCluster(splat, obb, options)`:

- awaits initialization and explicitly rejects LOD or paged inputs (`paged`, `enableLod === true`, or `lodSplats`/`lod` present on `packedSplats` or `extSplats`; a mesh carrying `lodSplats` is rejected even if `enableLod === false`);
- validates finite, non-negative margin, `minOpacity` in `[0,1]`, OBB position/size/quaternion, and invertible finite transforms;
- accepts zero-size and planar OBBs as lower-dimensional regions;
- scans every callback with inclusive tests `abs(axis) <= halfExtent + margin`;
- applies the inclusive opacity threshold only after geometric candidacy;
- skips and counts invalid indices, non-finite centres/transformed centres, and non-finite candidate opacities;
- deduplicates accepted indices and returns them in ascending numeric order;
- reports scanned, candidate, accepted, opacity-rejected, invalid, and duplicate counts plus scan duration.

No point-cloud fitting or semantic association occurs in this module.

### Mask rendering

`GaussianMaskManager` owns one 4096-wide R8UI texture and one appended object modifier. It:

- allocates a one-row texture for a zero-splat mesh rather than creating a zero-height texture;
- guards `texelFetch` with `0 <= gsplat.index < numSplats`;
- ignores invalid and duplicate incoming IDs and reports their counts;
- compares old/new membership and rewrites only bytes whose values change;
- submits `texture.needsUpdate` and `splat.updateVersion()` only when membership changes;
- returns separate CPU rewrite and submission timings;
- removes only its own modifier and disposes only its texture; repeated disposal is a no-op.

Lifting has no dependency on the mask manager. A caller may use the returned indices without rendering them.

## Browser-validated results

Environment: headless Chromium, ANGLE/SwiftShader, 640×480, Vite on `127.0.0.1:5199`. The validation page reported no shader errors, no page errors, no console errors, and final `gl.getError() == NO_ERROR`. Expected `ReadPixels` GPU-stall performance warnings were emitted; they are warnings, not test failures.

### Deterministic lifting fixtures

The packed fixture used exactly representable centres and an OBB with half-extents `(1,1,1)`.

| Test | Expected IDs | Result |
|---|---|---|
| Inside/outside, inclusive x/y boundaries | `[0,2,3,5,6,7]` | Pass, exact match |
| Margin `0.25` | `[0,1,2,3,5,6,7,9]` | Pass, exact match |
| `minOpacity` = stored value of splat 6 (`128/255`) | `[0,2,3,6,7]` | Pass; one opacity rejection |
| `minOpacity` = stored value + 1e-6 | `[0,2,3,7]` | Pass; splat 6 rejected, so the boundary is genuinely inclusive |
| Exactly representable opacities (mock, 0.5 / 0.25) | inclusive at `0.5`, empty at `0.5000001` | Pass |
| Empty mesh | `[]` | Pass; zero scanned |
| Zero-size OBB at origin | `[0]` | Pass |
| Planar OBB `(2,0,2)` full size | `[0,2,3]` | Pass |
| Invalid mock records | `[3]` | Pass; 9 scanned, 4 candidates, 5 invalid, 1 duplicate, 1 opacity rejection |
| Invalid OBB/options/transform | rejection | Pass |
| LOD/paged mocks, incl. `packedSplats.lodSplats`, `extSplats.lodSplats`, `lod` flags | explicit rejection from lifter and mask manager | Pass; empty source objects are not rejected |
| Real `Apartment-lod.rad` | explicit rejection from lifter and mask manager | Pass; no modifier left installed. Observed `numSplats` was 0 at that point, so without the guard the lifter would have silently returned nothing |

### Shader and lifecycle checks

| Check | Observed result |
|---|---|
| Mask vs equivalent inclusive OBB debug-region modifier (11-splat fixture, single texture row) | **0 differing pixels**; mask vs baseline changed 6,052 pixels |
| Negative control, every selected ID shifted by one | Pass; image differed from the correct mask |
| `clear()` and `replace([])` | Both restored the exact pixel baseline |
| Duplicate/invalid IDs | Valid set `[1,3]`, 2 duplicates and 5 invalid IDs reported |
| No-op replacement and no-op clear/empty replacement | No texture version, splat version, or upload-submission changes |
| Partial replacement | Exactly 2 changed bytes for one removal plus one addition |
| Distinct splat pose and OBB pose (rotated + translated, strict subset) | IDs exactly `[0,3,5,6,7]`, matching an independent axis-projection reference with 0.27 minimum boundary slack. Four wrong mappings (`S*inv(O)`, `inv(O)` only, `S` only, `inv(S)*O`) select different sets (`[0,5,7]`, `[0,1,2,3,5,6,7]`, `[0,5,6,7]`, `[0,1,2,4,5,6,9]`), and the lifter matches none of them. Applying one extra rigid motion to both poses left the IDs unchanged |
| 4096-wide layout at row boundaries | Meshes of 4096, 4097, 8192 and 8193 splats (1, 2, 2, 3 texture rows); IDs 0, 4094, 4095, 4096, 8190, 8191, 8192 each selected alone render **0 differing pixels** against a position-based debug-region reference, differ from every other marker's image, and `id == numSplats` is rejected |
| Post-selection translation and rotation | Membership stayed fixed, highlight remained visible and moved; restoring IDs reproduced the moved image exactly |
| Hover composition | Existing sentinel/mask/probe order retained; mask and hover each contributed visible pixels |
| Disposal | Only the mask modifier was removed, exact unmasked baseline restored, one texture dispose event; repeated disposal safe |
| Zero-splat manager | Safe creation, invalid ID rejection, and repeated disposal |

These are pixel-level and CPU-index checks on deterministic fixtures, not a claim of semantic object ownership.

## Failed tests and corrections during development

The **final** run had no failed tests. Earlier runs did fail and were not counted as passes:

1. The invalid-record fixture initially expected 4 invalid records; the actual correct count is 5 because `NaN` opacity is also invalid. The harness expectation was corrected.
2. The hover-composition assertion initially expected 3 modifiers; the actual chain is sentinel, mask, probe, hover (4). The harness expectation was corrected.
3. An added real-asset assertion showed that the first direct render after `replace()` changed **0 pixels**. The benchmark now reports that frame separately and searches subsequent frames for the first visible mask render. Frame 2 was first visible in the final run.
4. While strengthening the tests, the first joint-transform scenario failed my own boundary-slack guard (0.004), because rounding the offline-searched pose values moved it near a slab; the pose was re-searched with rounded values and the guard now measures only the decisive per-splat excess.

**Test strength.** After the tests were rewritten, four deliberate one-line breakages were applied by hand (not part of the suite) and each was caught by exactly the intended tests: swapped matrix order in the lifter, exclusive (`<=`) opacity comparison, `gmIndex >> 11` in the shader, and the previous `enableLod || packedSplats.lod || paged` guard. The previous 11-splat fixture could not have caught the shader row-shift mutation, since every ID there lies in row 0.

Repository-wide `npx tsc --noEmit` still exits non-zero on pre-existing errors: unused declarations in `gaussianIdProbe.ts`, `main.ts`, `script.ts`, and `utils.ts`, plus two `worldlabs.ts` index-signature errors. The new Phase 2 files produced no TypeScript diagnostics. These existing errors were not changed as part of this focused phase.

## Performance measurements

Single final run against non-LOD `Apartment.sog`, using a world-space OBB enclosing the complete transformed centre bounds (0.02 added to full size) and `minOpacity: 0.05`. This is intentionally a whole-scene scan/update, not an object-sized selection benchmark.

| Measurement | Final run |
|---|---:|
| Initialized splats | 699,086 |
| Total `liftCluster()` call | 58.2 ms |
| `forEachSplat` scan duration | 43.7 ms |
| Scanned / candidates | 699,086 / 699,086 |
| Accepted | 644,105 |
| Opacity rejected | 54,981 |
| Invalid / duplicate accepted | 0 / 0 |
| CPU mask rewrite, including validation/dedup/sort | 38.1 ms |
| Changed mask bytes | 644,105 |
| Mask upload-submission CPU work | 0.0 ms reported |
| First render submit / with `gl.finish()` | 0.2 / 0.2 ms |
| First render changed pixels | 0 |
| First visible render | Frame 2 |
| First visible render submit / with `gl.finish()` | 0.1 / 0.1 ms |
| First visible render changed pixels | 307,200 |

`upload-submission` covers only `needsUpdate` and Spark version invalidation. It is **not** evidence of completed GPU upload. Completed-render timings include `gl.finish()`, and visibility is separately established by pixel comparison. Browser timer resolution is 0.1 ms, so reported 0.0/0.1 ms values should be treated as resolution-limited. These are one-run SwiftShader measurements, not hardware-GPU throughput or statistically stable benchmarks.

Reproduce with Playwright available (Playwright is not a repo dependency; this run used a copy installed outside the repo and the cached headless Chromium via `PLAYWRIGHT_MODULE` / `CHROME_EXE`):

```sh
node scripts/phase2-validate.mjs
```

The runner starts Vite on port 5199 unless `PHASE2_URL` is supplied. `PLAYWRIGHT_MODULE` and `CHROME_EXE` can select an external Playwright module and Chromium executable.

## Untested behaviour

- Actual LOD/paged lifting or rendering; only explicit rejection was tested (mocks, and one real LOD asset, `Apartment-lod.rad`). A `lod: true` mesh whose `lodSplats` is built after initialization, and a real asset with `lodSplats` and `enableLod === false`, were not tested.
- Hardware GPU drivers, mobile browsers, WebGPU, multiple camera poses for the real asset, and frame-time impact during interactive navigation.
- Other non-LOD file formats and `ExtSplats`-backed meshes.
- Mirrored/negative-scale transforms and non-unit OBB quaternions (a non-unit quaternion is currently accepted and silently scales the box).
- Real-asset row-boundary behaviour: the 4096-row layout is validated on synthetic meshes, and `Apartment.sog` (171 rows) is only checked as "changes pixels".
- Concurrent source mutation or changing `numSplats` after manager creation.
- Long-run resource accounting beyond dispose events/modifier removal, and repeated memory-pressure cycles.
- Semantic correctness on extracted real-world objects, PCA fitting, covariance association, and multi-object ownership.

## Known limitations

- Lifting is synchronous O(N) CPU work on the main thread. The measured whole-scene scan fits the informal 200 ms budget in this environment, but no general performance guarantee is made.
- Membership uses Gaussian centres and source opacity only. Gaussian extent, covariance, depth consistency, occlusion, and semantic ownership are not considered.
- A margin expands an OBB; it does not turn a sparse surface sampling into a complete semantic segmentation.
- The manager represents one binary selection. Multi-object IDs, palettes, and production interaction are deliberately outside Phase 2.
- The mask texture uses approximately 700,416 bytes for this asset (4096 × 171), plus the selected-index array and transient `Set` overhead.
- A post-selection splat transform needs no rescan because storage IDs remain fixed. Changing the OBB or requesting a different region does require a new lift.
- Phase 1 OBB highlighting remains the fallback for this experiment; no LOD/paged fallback or support is implied.
