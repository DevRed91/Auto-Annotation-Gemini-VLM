import * as THREE from "three";
import { dyno, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { liftCluster } from "../utils/clusterLifter";
import { assertNonLodSplat } from "../utils/gaussianIndexSupport";
import { GaussianMaskManager } from "../utils/gaussianMaskManager";
import { HoverTint, OBB } from "../utils/hoverTint";
import { GaussianIdProbe } from "./gaussianIdProbe";

interface FixtureEntry {
  center: [number, number, number];
  opacity: number;
}

interface TestRecord {
  name: string;
  passed: boolean;
  details?: unknown;
  error?: string;
}

interface Phase2Report {
  startedAt: string;
  tests: TestRecord[];
  performance: Record<string, unknown> | null;
  shaderErrors: string[];
  finalGlError: number;
}

const FIXTURE: FixtureEntry[] = [
  { center: [0, 0, 0], opacity: 1 },       // 0: inside
  { center: [1.25, 0, 0], opacity: 1 },   // 1: outside, accepted with margin
  { center: [1, 0, 0], opacity: 1 },      // 2: +x boundary
  { center: [-1, 0, 0], opacity: 1 },     // 3: -x boundary
  { center: [1.5, 0, 0], opacity: 1 },    // 4: outside, including margin
  { center: [0, 0.5, 0], opacity: 0.25 }, // 5: opacity rejected at 0.5
  { center: [0, -0.5, 0], opacity: 0.5 }, // 6: stored as byte 128 => 128/255, not 0.5
  { center: [0, 1, 0], opacity: 1 },      // 7: +y boundary
  { center: [0, 0, 1.5], opacity: 1 },    // 8: outside z
  { center: [0, -1.25, 0], opacity: 1 },  // 9: accepted with margin
  { center: [2, 2, 2], opacity: 1 },      // 10: outside every slab
];
const BASE_IDS = [0, 2, 3, 5, 6, 7];
const MARGIN_IDS = [0, 1, 2, 3, 5, 6, 7, 9];
const OPACITY_IDS = [0, 2, 3, 6, 7];
const STRICT_OPACITY_IDS = [0, 2, 3, 7];

// Joint-transform scenario: splat pose S and a *different* OBB pose O. Values were
// searched offline so the correct inv(O)*S mapping selects a strict subset of the
// fixture that differs from the sets selected by four plausible wrong mappings.
const SPLAT_POSE = {
  position: new THREE.Vector3(0.7, -0.3, 0.4),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.45, -0.15)),
};
const OBB_POSE = {
  position: new THREE.Vector3(0.28, 0.26, 0.51),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.41, -0.08, -0.51)),
  size: new THREE.Vector3(2.2, 2.08, 1.7),
};

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(640, 480);
renderer.domElement.style.width = "640px";
renderer.domElement.style.height = "480px";
document.body.appendChild(renderer.domElement);

const report: Phase2Report = {
  startedAt: new Date().toISOString(),
  tests: [],
  performance: null,
  shaderErrors: [],
  finalGlError: 0,
};
renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
  report.shaderErrors.push([
    gl.getProgramInfoLog(program),
    gl.getShaderInfoLog(vertexShader),
    gl.getShaderInfoLog(fragmentShader),
  ].filter(Boolean).join("\n"));
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function ids(values: ArrayLike<number>): number[] {
  return Array.from(values as ArrayLike<number>);
}
function assertIds(actual: ArrayLike<number>, expected: number[]): void {
  assert(JSON.stringify(ids(actual)) === JSON.stringify(expected),
    `Expected IDs ${JSON.stringify(expected)}, got ${JSON.stringify(ids(actual))}`);
}
function assertNoGlError(): void {
  const gl = renderer.getContext();
  assert(gl.getError() === gl.NO_ERROR, "WebGL reported an error");
}
async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const details = await run();
    report.tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
    console.info(`[Phase2 PASS] ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    report.tests.push({ name, passed: false, error: message });
    console.warn(`[Phase2 FAIL] ${name}: ${message}`);
  }
}
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `Rejection did not match ${pattern}: ${message}`);
    return;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}
async function makeMesh(entries: FixtureEntry[]): Promise<SplatMesh> {
  const mesh = new SplatMesh({
    constructSplats: (packed) => {
      for (const entry of entries) {
        packed.pushSplat(
          new THREE.Vector3(...entry.center),
          new THREE.Vector3(0.09, 0.09, 0.09),
          new THREE.Quaternion(),
          entry.opacity,
          new THREE.Color(0.25, 0.4, 0.55),
        );
      }
    },
  });
  await mesh.initialized;
  return mesh;
}
function makeObb(size = new THREE.Vector3(2, 2, 2)): OBB {
  return new OBB({ size });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function renderFrames(scene: THREE.Scene, camera: THREE.Camera, count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    renderer.render(scene, camera);
    await sleep(50);
  }
  assertNoGlError();
}
function pixels(): Uint8Array {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, out);
  assertNoGlError();
  return out;
}
async function capture(scene: THREE.Scene, camera: THREE.Camera): Promise<Uint8Array> {
  await renderFrames(scene, camera);
  return pixels();
}
function pixelDiff(a: Uint8Array, b: Uint8Array, tolerance = 2): {
  count: number;
  bbox: [number, number, number, number] | null;
  center: [number, number] | null;
} {
  assert(a.length === b.length, "Pixel buffers have different sizes");
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const width = renderer.getContext().drawingBufferWidth;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tolerance ||
        Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
        Math.abs(a[i + 2] - b[i + 2]) > tolerance) {
      const pixel = i / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  return {
    count,
    bbox: count ? [minX, minY, maxX, maxY] : null,
    center: count ? [(minX + maxX) / 2, (minY + maxY) / 2] : null,
  };
}

type SplatCallback = Parameters<SplatMesh["forEachSplat"]>[0];
type MockRecord = { index: number; center: [number, number, number]; opacity: number };
function mockSplat(records: MockRecord[], numSplats = 4): SplatMesh {
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3(1, 1, 1);
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  return {
    initialized: Promise.resolve(null),
    numSplats,
    matrixWorld: new THREE.Matrix4(),
    updateWorldMatrix: () => {},
    forEachSplat: (callback: SplatCallback) => {
      for (const record of records) {
        center.set(...record.center);
        callback(record.index, center, scales, quaternion, record.opacity, color);
      }
    },
  } as unknown as SplatMesh;
}

/** Opacity as Spark actually stores/decodes it (byte-quantised), read via forEachSplat. */
function storedOpacity(mesh: SplatMesh, index: number): number {
  const found: { value: number | null } = { value: null };
  mesh.forEachSplat((i, _c, _s, _q, opacity) => { if (i === index) found.value = opacity; });
  assert(found.value !== null, `Splat ${index} not visited`);
  return found.value;
}

/**
 * Independent reference for the splat->OBB test: no matrix inversion. World centre =
 * R_s*c + t_s; local coordinate along each OBB axis = dot(world - t_o, R_o*e_i).
 * `slack` is the smallest distance from a membership decision to its boundary over all
 * splats (float32/float64 differences cannot matter above ~1e-5).
 */
function referenceLift(
  entries: FixtureEntry[],
  splat: { position: THREE.Vector3; quaternion: THREE.Quaternion },
  obb: { position: THREE.Vector3; quaternion: THREE.Quaternion; size: THREE.Vector3 },
): { ids: number[]; slack: number } {
  const axes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(obb.quaternion),
    new THREE.Vector3(0, 1, 0).applyQuaternion(obb.quaternion),
    new THREE.Vector3(0, 0, 1).applyQuaternion(obb.quaternion),
  ];
  const half = [obb.size.x / 2, obb.size.y / 2, obb.size.z / 2];
  const out: number[] = [];
  let slack = Infinity;
  entries.forEach((entry, index) => {
    const world = new THREE.Vector3(...entry.center).applyQuaternion(splat.quaternion).add(splat.position);
    const d = world.sub(obb.position);
    // Membership is decided by the largest per-axis excess (<= 0 means inside), so only
    // that value's distance from zero can flip the result.
    let maxExcess = -Infinity;
    for (let axis = 0; axis < 3; axis++) {
      maxExcess = Math.max(maxExcess, Math.abs(d.dot(axes[axis])) - half[axis]);
    }
    slack = Math.min(slack, Math.abs(maxExcess));
    if (maxExcess <= 0) out.push(index);
  });
  return { ids: out, slack };
}

/** Membership produced by applying a given 4x4 mapping to every fixture centre. */
function idsForMapping(entries: FixtureEntry[], mapping: THREE.Matrix4, size: THREE.Vector3): number[] {
  const out: number[] = [];
  entries.forEach((entry, index) => {
    const p = new THREE.Vector3(...entry.center).applyMatrix4(mapping);
    if (Math.abs(p.x) <= size.x / 2 && Math.abs(p.y) <= size.y / 2 && Math.abs(p.z) <= size.z / 2) {
      out.push(index);
    }
  });
  return out;
}

const poseMatrix = (p: { position: THREE.Vector3; quaternion: THREE.Quaternion }) =>
  new THREE.Matrix4().compose(p.position, p.quaternion, new THREE.Vector3(1, 1, 1));

/**
 * Layout fixture: `count` splats; only `markerIds` are on screen (distinct positions),
 * every other splat is parked far outside the frustum. Marker k sits at markerCenter(k).
 */
const MARKER_FILLER: FixtureEntry = { center: [100, 100, 0], opacity: 1 };
const markerCenter = (k: number): [number, number, number] => [-3.2 + 0.8 * k, k % 2 ? 0.6 : -0.6, 0];
function layoutEntries(count: number, markerIds: number[]): FixtureEntry[] {
  const entries: FixtureEntry[] = new Array(count).fill(MARKER_FILLER);
  markerIds.forEach((id, k) => { entries[id] = { center: markerCenter(k), opacity: 1 }; });
  return entries;
}

async function run(): Promise<void> {
  const fixture = await makeMesh(FIXTURE);
  const empty = await makeMesh([]);
  const unitObb = makeObb();

  await test("inside/outside and inclusive OBB boundaries return exact ascending IDs", async () => {
    const result = await liftCluster(fixture, unitObb);
    assertIds(result.indices, BASE_IDS);
    assert(result.diagnostics.scanned === FIXTURE.length, "Not every fixture splat was scanned");
    assert(result.diagnostics.candidates === BASE_IDS.length, "Unexpected candidate count");
    assert(result.diagnostics.accepted === BASE_IDS.length, "Unexpected accepted count");
  });

  await test("margin expands all OBB slabs inclusively", async () => {
    const result = await liftCluster(fixture, unitObb, { margin: 0.25 });
    assertIds(result.indices, MARGIN_IDS);
  });

  await test("opacity threshold is inclusive at the stored (byte-quantised) value", async () => {
    // Spark stores opacity as a byte, so fixture opacity 0.5 reads back as 128/255
    // (~0.50196). Thresholds are therefore derived from the value actually stored.
    const stored = storedOpacity(fixture, 6);
    assert(Math.abs(stored - 128 / 255) < 1e-9, `Unexpected stored opacity ${stored}`);
    assert(stored !== 0.5, "Fixture opacity unexpectedly round-trips exactly; boundary test is vacuous");

    const atBoundary = await liftCluster(fixture, unitObb, { minOpacity: stored });
    assertIds(atBoundary.indices, OPACITY_IDS);
    assert(atBoundary.diagnostics.opacityRejected === 1, "Expected only splat 5 rejected at the boundary");

    const justAbove = await liftCluster(fixture, unitObb, { minOpacity: stored + 1e-6 });
    assertIds(justAbove.indices, STRICT_OPACITY_IDS);
    assert(justAbove.diagnostics.opacityRejected === 2, "Expected splats 5 and 6 rejected just above the boundary");

    const justBelow = await liftCluster(fixture, unitObb, { minOpacity: stored - 1e-6 });
    assertIds(justBelow.indices, OPACITY_IDS);
    return { stored, atBoundary: ids(atBoundary.indices), justAbove: ids(justAbove.indices) };
  });

  await test("opacity comparison is inclusive for exactly representable values", async () => {
    const mocked = mockSplat([
      { index: 0, center: [0, 0, 0], opacity: 0.5 },
      { index: 1, center: [0, 0, 0], opacity: 0.25 },
    ], 2);
    assertIds((await liftCluster(mocked, unitObb, { minOpacity: 0.5 })).indices, [0]);
    assertIds((await liftCluster(mocked, unitObb, { minOpacity: 0.5000001 })).indices, []);
    assertIds((await liftCluster(mocked, unitObb, { minOpacity: 0.25 })).indices, [0, 1]);
  });

  await test("empty meshes and zero-size/planar OBBs are safe", async () => {
    const emptyResult = await liftCluster(empty, unitObb);
    assertIds(emptyResult.indices, []);
    assert(emptyResult.diagnostics.scanned === 0, "Empty mesh was scanned");
    const point = await liftCluster(fixture, makeObb(new THREE.Vector3(0, 0, 0)));
    assertIds(point.indices, [0]);
    const plane = await liftCluster(fixture, makeObb(new THREE.Vector3(2, 0, 2)));
    assertIds(plane.indices, [0, 2, 3]);
  });

  await test("invalid callback data is counted and skipped; output is unique and valid", async () => {
    const mocked = mockSplat([
      { index: 3, center: [0, 0, 0], opacity: 1 },
      { index: 1, center: [NaN, 0, 0], opacity: 1 },
      { index: 2, center: [0, 0, 0], opacity: NaN },
      { index: 3, center: [0, 0, 0], opacity: 1 },
      { index: 0, center: [2, 0, 0], opacity: 1 },
      { index: 4, center: [0, 0, 0], opacity: 1 },
      { index: 1.5, center: [0, 0, 0], opacity: 1 },
      { index: 1, center: [0, 0, 0], opacity: 0.1 },
      { index: 0, center: [Infinity, 0, 0], opacity: 1 },
    ]);
    const result = await liftCluster(mocked, unitObb, { minOpacity: 0.5 });
    assertIds(result.indices, [3]);
    assert(result.diagnostics.scanned === 9, "Unexpected mock scan count");
    assert(result.diagnostics.candidates === 4, "Unexpected mock candidate count");
    assert(result.diagnostics.invalid === 5, "Unexpected invalid count");
    assert(result.diagnostics.duplicateIndices === 1, "Duplicate index was not counted");
    assert(result.diagnostics.opacityRejected === 1, "Mock opacity rejection was not counted");
  });

  await test("invalid OBBs/options/transforms and LOD/paged inputs reject explicitly", async () => {
    await expectRejection(
      liftCluster(fixture, makeObb(new THREE.Vector3(-1, 1, 1))), /non-negative/,
    );
    const badQuaternion = makeObb();
    badQuaternion.quaternion.set(0, 0, 0, 0);
    await expectRejection(liftCluster(fixture, badQuaternion), /quaternion/);
    await expectRejection(liftCluster(fixture, unitObb, { margin: -1 }), /margin/);
    await expectRejection(liftCluster(fixture, unitObb, { minOpacity: 2 }), /minOpacity/);
    const lod = mockSplat([]);
    lod.enableLod = true;
    await expectRejection(liftCluster(lod, unitObb), /non-LOD/);
    const paged = mockSplat([]);
    paged.paged = {} as SplatMesh["paged"];
    await expectRejection(liftCluster(paged, unitObb), /non-paged/);
    const singular = mockSplat([]);
    singular.matrixWorld.makeScale(0, 1, 1);
    await expectRejection(liftCluster(singular, unitObb), /invertible/);
  });

  await test("LOD signals other than enableLod are rejected by lifter and mask (mock)", async () => {
    const variants: Array<[string, (mesh: SplatMesh) => void]> = [
      ["packedSplats.lodSplats", (m) => { (m as any).packedSplats = { lodSplats: {} }; }],
      ["extSplats.lodSplats", (m) => { (m as any).extSplats = { lodSplats: {} }; }],
      ["packedSplats.lod", (m) => { (m as any).packedSplats = { lod: true }; }],
      ["extSplats.lod", (m) => { (m as any).extSplats = { lod: "quality" }; }],
    ];
    for (const [label, apply] of variants) {
      const mesh = mockSplat([]);
      apply(mesh);
      try {
        await expectRejection(liftCluster(mesh, unitObb), /non-LOD/);
        await expectRejection(GaussianMaskManager.create(mesh), /non-LOD/);
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Controls: a plain mesh and one with empty source objects must NOT be rejected.
    const plain = mockSplat([]);
    (plain as any).packedSplats = {};
    (plain as any).extSplats = {};
    await liftCluster(plain, unitObb);
    return { rejected: variants.map(([label]) => label) };
  });

  await test("real Apartment-lod.rad is rejected by lifter and mask manager", async () => {
    const lodMesh = new SplatMesh({ url: new URL("/Apartment-lod.rad", location.origin).href });
    try {
      await lodMesh.initialized;
      const signals = {
        numSplats: lodMesh.numSplats,
        enableLod: lodMesh.enableLod ?? null,
        paged: Boolean(lodMesh.paged),
        packedLodSplats: Boolean(lodMesh.packedSplats?.lodSplats),
        extLodSplats: Boolean((lodMesh as any).extSplats?.lodSplats),
        packedLodFlag: (lodMesh.packedSplats as any)?.lod ?? null,
      };
      assert(
        signals.paged || signals.packedLodSplats || signals.extLodSplats || signals.packedLodFlag || signals.enableLod,
        `Apartment-lod.rad exposes no LOD signal: ${JSON.stringify(signals)}`,
      );
      await expectRejection(liftCluster(lodMesh, unitObb), /non-LOD/);
      await expectRejection(GaussianMaskManager.create(lodMesh), /non-LOD/);
      assert((lodMesh.objectModifiers ?? []).length === 0, "Rejected mask creation left a modifier installed");
      return signals;
    } finally {
      lodMesh.dispose();
    }
  });

  const fixtureScene = new THREE.Scene();
  fixtureScene.background = new THREE.Color(0x000000);
  const fixtureSpark = new SparkRenderer({ renderer });
  fixtureScene.add(fixtureSpark, fixture);
  const fixtureCamera = new THREE.PerspectiveCamera(45, 640 / 480, 0.01, 100);
  fixtureCamera.position.set(0, 0, 8);
  fixtureCamera.lookAt(0, 0, 0);
  fixtureCamera.updateMatrixWorld(true);

  const sentinel = dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => ({ gsplat }),
  );
  fixture.objectModifiers = [sentinel];
  fixture.updateGenerator();
  const mask = await GaussianMaskManager.create(fixture);
  const maskModifier = fixture.objectModifiers?.find((modifier) => modifier !== sentinel);
  assert(maskModifier, "Mask modifier was not installed");
  const probe = new GaussianIdProbe(fixture, fixture.numSplats);
  const hover = new HoverTint(fixture);
  let baseline = await capture(fixtureScene, fixtureCamera);

  await test("shader mask equals the equivalent inclusive OBB debug region", async () => {
    const lifted = await liftCluster(fixture, unitObb);
    mask.replace(lifted.indices);
    const masked = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(masked, baseline).count > 0, "Mask did not change any pixels");
    mask.clear();
    probe.setDebugRegion(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    fixture.updateVersion();
    const reference = await capture(fixtureScene, fixtureCamera);
    const difference = pixelDiff(masked, reference, 0);
    assert(difference.count === 0, `Mask/reference differ by ${difference.count} pixels`);
    report.tests.push({
      name: "shader reference changed-pixel count",
      passed: true,
      details: { maskVsBaseline: pixelDiff(masked, baseline).count },
    });
    probe.setDebugRegion(null);
    fixture.updateVersion();
    mask.replace(lifted.indices);
  });

  await test("negative control with shifted IDs produces a different image", async () => {
    const expected = await capture(fixtureScene, fixtureCamera);
    mask.replace(BASE_IDS.map((id) => id + 1));
    const shifted = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(expected, shifted).count > 0, "Shifted-ID negative control matched the mask");
    mask.replace(BASE_IDS);
  });

  await test("clear and empty replacement restore the exact pixel baseline", async () => {
    mask.clear();
    const cleared = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(cleared, baseline).count === 0, "clear() did not restore baseline");
    mask.replace(BASE_IDS);
    mask.replace([]);
    const emptied = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(emptied, baseline).count === 0, "replace([]) did not restore baseline");
  });

  await test("mask IDs validate/deduplicate and only changed bytes trigger updates", async () => {
    const update = mask.replace([3, 3, 1, 1, -1, 1.5, NaN, Infinity, 99]);
    assertIds(mask.selectedIds, [1, 3]);
    assert(update.validIds === 2 && update.duplicateIds === 2 && update.invalidIds === 5,
      "Unexpected ID validation diagnostics");
    const version = fixture.version;
    const textureVersion = mask.texture.version;
    const submissions = mask.uploadSubmissions;
    const noOp = mask.replace([3, 1, 3]);
    assert(!noOp.changed && noOp.changedBytes === 0, "Equivalent replacement changed the mask");
    assert(fixture.version === version && mask.texture.version === textureVersion &&
      mask.uploadSubmissions === submissions, "No-op replace invalidated texture or splat");
    const partial = mask.replace([3, 4]);
    assert(partial.changedBytes === 2, `Expected two changed bytes, got ${partial.changedBytes}`);
    mask.clear();
    const emptyVersion = fixture.version;
    const emptyTextureVersion = mask.texture.version;
    const clearNoOp = mask.clear();
    const replaceNoOp = mask.replace([]);
    assert(!clearNoOp.changed && !replaceNoOp.changed && fixture.version === emptyVersion &&
      mask.texture.version === emptyTextureVersion, "No-op clear/empty replacement changed versions");
  });

  await test("HoverTint appends and composes after existing modifiers", async () => {
    const current = fixture.objectModifiers ?? [];
    assert(current[0] === sentinel && current[1] === maskModifier && current.length === 4,
      "HoverTint did not preserve existing modifier order");
    mask.replace(BASE_IDS);
    const maskOnly = await capture(fixtureScene, fixtureCamera);
    hover.setHovered(makeObb(new THREE.Vector3(4, 4, 4)));
    const both = await capture(fixtureScene, fixtureCamera);
    mask.clear();
    const hoverOnly = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(both, maskOnly).count > 0, "Hover did not add to the mask image");
    assert(pixelDiff(both, hoverOnly).count > 0, "Mask did not add to the hover image");
    hover.setHovered(null);
    baseline = await capture(fixtureScene, fixtureCamera);
  });

  await test("splat->OBB mapping is correct for distinct splat and OBB poses (with negative controls)", async () => {
    const obb = new OBB({ position: OBB_POSE.position, quaternion: OBB_POSE.quaternion, size: OBB_POSE.size });
    const expected = referenceLift(FIXTURE, SPLAT_POSE, OBB_POSE);
    assert(expected.ids.length >= 3 && expected.ids.length < FIXTURE.length - 2,
      `Scenario is not a strict, non-trivial subset: ${JSON.stringify(expected.ids)}`);
    assert(expected.slack > 0.1, `Scenario is too close to a boundary (slack ${expected.slack})`);

    // The scenario must discriminate: every plausible wrong mapping selects a different set.
    const S = poseMatrix(SPLAT_POSE);
    const O = poseMatrix(OBB_POSE);
    const Oinv = O.clone().invert();
    const wrong: Record<string, number[]> = {
      "S*inv(O) (swapped order)": idsForMapping(FIXTURE, S.clone().multiply(Oinv), OBB_POSE.size),
      "inv(O) only (ignores splat transform)": idsForMapping(FIXTURE, Oinv, OBB_POSE.size),
      "S only (ignores OBB transform)": idsForMapping(FIXTURE, S, OBB_POSE.size),
      "inv(S)*O (reversed direction)": idsForMapping(FIXTURE, S.clone().invert().multiply(O), OBB_POSE.size),
    };
    const correctViaMatrices = idsForMapping(FIXTURE, Oinv.clone().multiply(S), OBB_POSE.size);
    assert(JSON.stringify(correctViaMatrices) === JSON.stringify(expected.ids),
      "Matrix mapping and axis-projection reference disagree; scenario is unsound");
    for (const [label, wrongIds] of Object.entries(wrong)) {
      assert(JSON.stringify(wrongIds) !== JSON.stringify(expected.ids),
        `Negative control '${label}' selects the same set; scenario cannot detect it`);
    }

    fixture.position.copy(SPLAT_POSE.position);
    fixture.quaternion.copy(SPLAT_POSE.quaternion);
    try {
      const lifted = await liftCluster(fixture, obb);
      assertIds(lifted.indices, expected.ids);
      for (const [label, wrongIds] of Object.entries(wrong)) {
        assert(JSON.stringify(ids(lifted.indices)) !== JSON.stringify(wrongIds),
          `Lifter result matches wrong mapping '${label}'`);
      }

      // Joint rigid motion G applied to BOTH poses must leave the membership unchanged.
      const G = new THREE.Matrix4().compose(
        new THREE.Vector3(-1.3, 0.9, 2.1),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 1.1, 0.35)),
        new THREE.Vector3(1, 1, 1),
      );
      const scratchScale = new THREE.Vector3();
      G.clone().multiply(S).decompose(fixture.position, fixture.quaternion, scratchScale);
      G.clone().multiply(O).decompose(obb.position, obb.quaternion, scratchScale);
      const moved = await liftCluster(fixture, obb);
      assertIds(moved.indices, expected.ids);
      return { expected: expected.ids, slack: expected.slack, wrong };
    } finally {
      fixture.position.set(0, 0, 0);
      fixture.quaternion.identity();
    }
  });

  await test("post-selection transforms preserve membership and move the highlight", async () => {
    mask.replace(OPACITY_IDS);
    const before = await capture(fixtureScene, fixtureCamera);
    const beforeDiff = pixelDiff(before, baseline);
    fixture.position.set(0.7, 0.15, -0.2);
    fixture.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.45);
    const after = await capture(fixtureScene, fixtureCamera);
    const afterDiff = pixelDiff(after, baseline);
    assertIds(mask.selectedIds, OPACITY_IDS);
    mask.clear();
    const movedOff = await capture(fixtureScene, fixtureCamera);
    const visibleAfter = pixelDiff(after, movedOff);
    assert(visibleAfter.count > 0, "Moved selection is not visible");
    assert(pixelDiff(before, after).count > 0, "Selection image did not move");
    assert(beforeDiff.center && afterDiff.center &&
      Math.hypot(beforeDiff.center[0] - afterDiff.center[0], beforeDiff.center[1] - afterDiff.center[1]) > 1,
      "Changed-pixel region centre did not move");
    mask.replace(OPACITY_IDS);
    const restored = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(after, restored).count === 0, "Restored membership differs after movement");
    mask.clear();
    fixture.position.set(0, 0, 0);
    fixture.quaternion.identity();
  });

  await test("disposal removes only its modifier, restores pixels, and is idempotent", async () => {
    mask.replace(BASE_IDS);
    await capture(fixtureScene, fixtureCamera);
    let disposeEvents = 0;
    mask.texture.addEventListener("dispose", () => { disposeEvents++; });
    const before = fixture.objectModifiers?.slice() ?? [];
    mask.dispose();
    const after = fixture.objectModifiers ?? [];
    assert(!after.includes(maskModifier), "Mask modifier remains after disposal");
    assert(after.length === before.length - 1 && after[0] === sentinel,
      "Disposal removed or reordered another modifier");
    const unmasked = await capture(fixtureScene, fixtureCamera);
    assert(pixelDiff(unmasked, baseline).count === 0, "Disposal did not remove the highlight");
    mask.dispose();
    assert(disposeEvents === 1 && mask.isDisposed, "Repeated disposal released resources twice");
    assert((fixture.objectModifiers ?? []).length === after.length, "Repeated disposal changed modifiers");
    assertNoGlError();
  });

  await test("zero-splat mask creation, invalid replacement and disposal are safe", async () => {
    const zeroMask = await GaussianMaskManager.create(empty);
    assert(zeroMask.texture.image.height === 1 && zeroMask.count === 0, "Zero-splat texture is invalid");
    const invalid = zeroMask.replace([0]);
    assert(!invalid.changed && invalid.invalidIds === 1, "Zero-splat ID was not rejected");
    zeroMask.dispose();
    zeroMask.dispose();
    assert(zeroMask.isDisposed, "Zero-splat manager did not dispose");
  });

  await test("mask texture layout is correct across 4096-wide row boundaries", async () => {
    // Each case: only `markers` are on screen; all other splats are parked off-screen.
    // For every marker ID the shader-selected image (index -> (id&4095, id>>12)) must
    // equal a reference that selects the same splat by *position* (debug region), and
    // must differ from the image of every other marker (wrong-row/column negative control).
    const cases: Array<{ count: number; markers: number[]; rows: number }> = [
      { count: 4096, markers: [0, 4094, 4095], rows: 1 },
      { count: 4097, markers: [4095, 4096], rows: 2 },
      { count: 8192, markers: [4095, 4096, 8190, 8191], rows: 2 },
      { count: 8193, markers: [8191, 8192], rows: 3 },
    ];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const layoutSpark = new SparkRenderer({ renderer });
    scene.add(layoutSpark);
    const region = (k: number): [THREE.Vector3, THREE.Vector3] => {
      const [x, y] = markerCenter(k);
      return [new THREE.Vector3(x - 0.1, y - 0.1, -0.1), new THREE.Vector3(x + 0.1, y + 0.1, 0.1)];
    };
    const summary: unknown[] = [];

    for (const { count, markers, rows } of cases) {
      const mesh = await makeMesh(layoutEntries(count, markers));
      scene.add(mesh);
      const layoutMask = await GaussianMaskManager.create(mesh);
      const layoutProbe = new GaussianIdProbe(mesh, count);
      try {
        const label = `n=${count}`;
        assert(mesh.numSplats === count, `${label}: mesh has ${mesh.numSplats} splats`);
        assert(layoutMask.texture.image.height === rows,
          `${label}: expected ${rows} texture rows, got ${layoutMask.texture.image.height}`);
        const outOfRange = layoutMask.replace([count]);
        assert(!outOfRange.changed && outOfRange.invalidIds === 1, `${label}: id == numSplats was not rejected`);

        const base = await capture(scene, fixtureCamera);
        const images = new Map<number, Uint8Array>();
        for (let k = 0; k < markers.length; k++) {
          const id = markers[k];
          layoutMask.replace([id]);
          assertIds(layoutMask.selectedIds, [id]);
          const masked = await capture(scene, fixtureCamera);
          assert(pixelDiff(masked, base).count > 0, `${label}: selecting id ${id} changed nothing`);

          layoutMask.clear();
          const [lo, hi] = region(k);
          layoutProbe.setDebugRegion(lo, hi);
          mesh.updateVersion();
          const reference = await capture(scene, fixtureCamera);
          layoutProbe.setDebugRegion(null);
          mesh.updateVersion();
          const diff = pixelDiff(masked, reference, 0);
          assert(diff.count === 0, `${label}: id ${id} mask differs from position reference by ${diff.count} pixels`);
          images.set(id, masked);
        }
        for (let a = 0; a < markers.length; a++) {
          for (let b = a + 1; b < markers.length; b++) {
            assert(pixelDiff(images.get(markers[a])!, images.get(markers[b])!).count > 0,
              `${label}: ids ${markers[a]} and ${markers[b]} produced identical images`);
          }
        }

        layoutMask.replace(markers);
        const all = await capture(scene, fixtureCamera);
        layoutMask.clear();
        const [lo0] = region(0);
        const [, hiLast] = region(markers.length - 1);
        layoutProbe.setDebugRegion(new THREE.Vector3(-3.6, -1, -0.1), new THREE.Vector3(3.6, 1, 0.1));
        assert(lo0.x >= -3.6 && hiLast.x <= 3.6, "all-markers region does not cover the markers");
        mesh.updateVersion();
        const allReference = await capture(scene, fixtureCamera);
        layoutProbe.setDebugRegion(null);
        mesh.updateVersion();
        assert(pixelDiff(all, allReference, 0).count === 0, `${label}: all-marker mask differs from reference`);
        summary.push({ count, rows, markers });
      } finally {
        layoutMask.dispose();
        mesh.removeFromParent();
        mesh.dispose();
      }
    }
    scene.remove(layoutSpark);
    return summary;
  });

  await test("Apartment.sog non-LOD scan and mask/render performance", async () => {
    const apartment = new SplatMesh({ url: new URL("/Apartment.sog", location.origin).href });
    apartment.quaternion.set(1, 0, 0, 0);
    apartment.position.set(0, -1.5, 0);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const spark = new SparkRenderer({ renderer });
    scene.add(spark, apartment);
    const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.01, 1000);
    camera.position.set(0, 0.4, 0);
    camera.lookAt(0, 0.4, -1);
    camera.updateMatrixWorld(true);
    await apartment.initialized;
    assertNonLodSplat(apartment, "Apartment.sog precondition");
    await renderFrames(scene, camera, 8);
    apartment.updateWorldMatrix(true, false);
    const worldBounds = apartment.getBoundingBox(true).applyMatrix4(apartment.matrixWorld);
    const obb = new OBB({
      position: worldBounds.getCenter(new THREE.Vector3()),
      size: worldBounds.getSize(new THREE.Vector3()).addScalar(0.02),
    });
    const apartmentMask = await GaussianMaskManager.create(apartment);
    await renderFrames(scene, camera, 4);
    const apartmentBaseline = pixels();

    const liftStart = performance.now();
    const lifted = await liftCluster(apartment, obb, { minOpacity: 0.05 });
    const liftTotalMs = performance.now() - liftStart;
    assert(lifted.indices.length > 0, "Apartment full-bounds lift returned no IDs");
    const update = apartmentMask.replace(lifted.indices);
    const firstRenderStart = performance.now();
    renderer.render(scene, camera);
    const firstRenderSubmitMs = performance.now() - firstRenderStart;
    renderer.getContext().finish();
    const firstRenderCompletedMs = performance.now() - firstRenderStart;
    const firstRenderChangedPixels = pixelDiff(apartmentBaseline, pixels()).count;
    assertNoGlError();

    let firstVisibleRenderIndex = firstRenderChangedPixels > 0 ? 1 : null;
    let firstVisibleRenderSubmitMs = firstRenderSubmitMs;
    let firstVisibleRenderCompletedMs = firstRenderCompletedMs;
    let firstVisibleRenderChangedPixels = firstRenderChangedPixels;
    for (let renderIndex = 2; renderIndex <= 8 && firstVisibleRenderIndex === null; renderIndex++) {
      await sleep(0);
      const visibleRenderStart = performance.now();
      renderer.render(scene, camera);
      const submitMs = performance.now() - visibleRenderStart;
      renderer.getContext().finish();
      const completedMs = performance.now() - visibleRenderStart;
      const changedPixels = pixelDiff(apartmentBaseline, pixels()).count;
      assertNoGlError();
      if (changedPixels > 0) {
        firstVisibleRenderIndex = renderIndex;
        firstVisibleRenderSubmitMs = submitMs;
        firstVisibleRenderCompletedMs = completedMs;
        firstVisibleRenderChangedPixels = changedPixels;
      }
    }
    report.performance = {
      asset: "Apartment.sog",
      initializedSplats: apartment.numSplats,
      lod: false,
      liftTotalMs,
      scan: lifted.diagnostics,
      mask: update,
      firstRenderSubmitMs,
      firstRenderCompletedMs,
      firstRenderChangedPixels,
      firstVisibleRenderIndex,
      firstVisibleRenderSubmitMs,
      firstVisibleRenderCompletedMs,
      firstVisibleRenderChangedPixels,
      note: "submissionMs is needsUpdate/updateVersion CPU work; completed timings include gl.finish(); visible means pixels differ from baseline",
    };
    assert(firstVisibleRenderIndex !== null, "Apartment mask produced no visible render within eight frames");
    apartmentMask.dispose();
    apartment.dispose();
  });

  mask.dispose();
  probe.clear(false);
  fixture.dispose();
  empty.dispose();
  report.finalGlError = renderer.getContext().getError();
}

(async () => {
  try {
    await run();
  } catch (error) {
    report.tests.push({
      name: "harness initialization/cleanup",
      passed: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
  const passed = report.tests.filter((entry) => entry.passed).length;
  const failed = report.tests.length - passed;
  const output = document.createElement("pre");
  output.textContent = `Phase 2: ${passed} passed, ${failed} failed\n${JSON.stringify(report, null, 2)}`;
  output.style.cssText = "position:absolute;inset:0;overflow:auto;background:#111;color:#eee;padding:16px;white-space:pre-wrap";
  document.body.appendChild(output);
  (window as unknown as { __phase2: { ready: boolean; report: Phase2Report } }).__phase2 = {
    ready: true,
    report,
  };
})();
