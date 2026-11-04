import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Compile just the pure flaw modules in memory; no test-runner dependency needed.
async function moduleUrl(name, imports = {}) {
  let source = await readFile(new URL(`../src/flaw/${name}.ts`, import.meta.url), "utf8");
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll(`"${specifier}"`, JSON.stringify(url));
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}
const storeUrl = await moduleUrl("GaussianStore");
const { GaussianStore } = await import(storeUrl);
const { RectificationHistory, rectificationNotice } = await import(await moduleUrl("rectify", { "./GaussianStore": storeUrl }));
const typesUrl = await moduleUrl("types");
const { diagnose } = await import(await moduleUrl("diagnosisClient", { "./types": typesUrl }));
function fixture(count = 100, type = "float32") {
  const header = Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment caf?\nelement vertex ${count}\nproperty ${type} opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nelement metadata 1\nproperty uchar quality\nend_header\n`);
  const bytes = new Uint8Array(header.length + count * 16 + 1);
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    view.setFloat32(header.length + i * 16 + 8, Math.log(5), true);
  }
  bytes[bytes.length - 1] = 123;
  return bytes;
}
const lift = (flaw, indices, detached, votes) => ({ class: flaw, indices: Uint32Array.from(indices), detached: Uint8Array.from(detached), votes: votes && Uint32Array.from(votes) });

test("PLY round trip, alias types, trailing element, dirty tracking and original reconstruction", () => {
  const bytes = fixture();
  const original = bytes.slice();
  const store = GaussianStore.fromBytes(bytes);
  assert.deepEqual(store.exportBytes(), original);
  assert.equal(store.hasEdits, false);
  assert.equal(store.isPruned, store.isPruned);
  store.set(0, "opacity", 4);
  assert.equal(store.hasEdits, true);
  assert.deepEqual(store.exportUnchangedBytes(), original);
  store.set(0, "opacity", 0);
  assert.equal(store.hasEdits, false);
  store.markPruned(0);
  assert.equal(store.hasEdits, true);
  const pruned = GaussianStore.fromBytes(store.exportBytes());
  assert.equal(pruned.vertexCount, 99);
  assert.equal(pruned.stride, 16);
  assert.equal(pruned.fileBytes.at(-1), 123);
  store.markPruned(0, false);
  assert.equal(store.hasEdits, false);
  assert.throws(() => GaussianStore.fromBytes(fixture(100, "mystery")), /Unsupported/);
});

test("prune highest votes within budget, edit every non-detached floater, undo as one group", () => {
  const store = GaussianStore.fromBytes(fixture());
  const history = new RectificationHistory();
  history.apply(store, lift("Floater", [0, 1, 2, 3, 4, 5], [1, 1, 1, 0, 0, 0], [1, 9, 8, 2, 3, 4]));
  assert.deepEqual(Array.from(store.isPruned.slice(0, 6)), [0, 1, 1, 0, 0, 0]);
  for (const i of [0, 1, 2]) assert.equal(store.get(i, "opacity"), 0);
  for (const i of [3, 4, 5]) assert.ok(Math.abs(1 / (1 + Math.exp(-store.get(i, "opacity"))) - 0.325) < 1e-6);
  history.undo(store);
  assert.equal(store.hasEdits, false);
  history.redo(store);
  assert.equal(store.isPruned[1], 1);
  assert.ok(store.get(5, "opacity") < 0);
});

test("largest scale axis, ghosting anisotropy gate, grouped opacity and scale undo", () => {
  const store = GaussianStore.fromBytes(fixture());
  store.set(1, "scale_1", Math.log(2));
  const original = store.exportBytes();
  const history = new RectificationHistory();
  history.apply(store, lift("Ghosting", [0, 1], [0, 0]));
  assert.equal(store.get(0, "scale_0"), 0);
  assert.ok(Math.abs(store.get(0, "scale_1") - Math.log(4.5)) < 1e-6);
  assert.ok(Math.abs(store.get(1, "scale_1") - Math.log(2)) < 1e-6);
  history.undo(store);
  assert.deepEqual(store.exportBytes(), original);
  history.apply(store, lift("Needle Stretch", [0], [0]));
  assert.ok(Math.abs(store.get(0, "scale_1") - Math.log(3.75)) < 1e-6);
});

test("opacity stays finite at extreme logits and unsupported edits have a notice", () => {
  const store = GaussianStore.fromBytes(fixture());
  store.set(0, "opacity", -1000);
  new RectificationHistory().apply(store, lift("Haze", [0], [0]));
  assert.ok(Number.isFinite(store.get(0, "opacity")));
  assert.match(rectificationNotice("Specular Collapse"), /not implemented/);
});

test("diagnosis rejects invalid classes and boxes, normalizes confidence and mask contract", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [
      { class: "Floater", box: [100, 200, 500, 600], mask: "png", confidence: "bad" },
      { class: "Invalid", box: [0, 0, 1000, 1000], mask: "png" },
      { class: "Haze", box: [500, 0, 100, 1000], mask: "png" },
      null,
    ] });
    const result = await diagnose("/api/diagnose", "image", { x: 0.5, y: 0.5 });
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0);
    assert.equal(result[0].maskSpace, "box");
  } finally { globalThis.fetch = previousFetch; }
});

test("diagnosis preserves backend error details and explains empty proxy errors", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "Diagnosis provider failed", details: "Model unavailable",
    }), { status: 502 });
    await assert.rejects(diagnose("/api/diagnose", "image", { x: 0.5, y: 0.5 }),
      /502.*Diagnosis provider failed: Model unavailable/);
    globalThis.fetch = async () => new Response("", { status: 502 });
    await assert.rejects(diagnose("/api/diagnose", "image", { x: 0.5, y: 0.5 }),
      /502.*localhost:3000/);
    globalThis.fetch = async () => new Response("upstream connection refused", { status: 502 });
    await assert.rejects(diagnose("/api/diagnose", "image", { x: 0.5, y: 0.5 }),
      /502.*upstream connection refused/);
    globalThis.fetch = async () => new Response("<!DOCTYPE html><pre>Cannot POST /api/diagnose</pre>", { status: 404 });
    await assert.rejects(diagnose("/api/diagnose", "image", { x: 0.5, y: 0.5 }),
      /404.*does not expose POST \/api\/diagnose/);
  } finally { globalThis.fetch = previousFetch; }
});


test("region decoder places box-local masks and supports explicit full-frame masks", async () => {
  const { decodeRegions } = await import(await moduleUrl("regions"));
  const previousImage = globalThis.Image;
  const previousDocument = globalThis.document;
  const calls = [];
  try {
    globalThis.Image = class { async decode() {} };
    globalThis.document = { createElement: () => ({ getContext: () => ({
      drawImage: (...args) => calls.push(args.slice(1)),
      getImageData: () => ({ data: new Uint8ClampedArray(200 * 100 * 4) }),
    }) }) };
    const detection = { class: "Floater", box: [100, 200, 500, 800], mask: "png", confidence: 1 };
    await decodeRegions([detection, { ...detection, maskSpace: "full-frame" }], 200, 100);
    assert.deepEqual(calls, [[40, 10, 120, 40], [0, 0, 200, 100]]);
  } finally {
    globalThis.Image = previousImage;
    globalThis.document = previousDocument;
  }
});

test("undo and redo return the affected group so the viewer can resync splats", () => {
  const store = GaussianStore.fromBytes(fixture());
  const history = new RectificationHistory();
  assert.equal(history.canUndo, false);
  const applied = history.apply(store, lift("Haze", [3, 4], [0, 0]));
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo(store), applied);
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(store), applied);
  assert.equal(history.redo(store), undefined);
});

test("single-view lift selects visible Gaussians in the mask and flags the detached floater", async () => {
  const { liftRegion } = await import(await moduleUrl("lift"));
  const centers = [], alphas = [], radii = [];
  const add = (x, y, z, alpha) => { centers.push(x, y, z); alphas.push(alpha); radii.push(0.05); };
  for (let i = -30; i <= 30; i++) for (let j = -30; j <= 30; j++) add(i / 10, j / 10, -10, 0.9); // wall
  const wallCount = alphas.length;
  const floater = alphas.length; add(0.1, 0.1, -3, 0.3);
  const hidden = alphas.length; add(0, 0, -15, 0.9);
  const outside = alphas.length; add(2.9, 2.9, -3, 0.3); // floater-like but outside the mask
  const objectStart = alphas.length; // dense foreground object: nearer than the wall but self-supporting
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) add(-0.5 + i * 0.05, -0.5 + j * 0.05, -5, 0.9);
  const objectEnd = alphas.length;
  // 90 degree perspective camera at the origin looking down -Z (column-major).
  const near = 0.1, far = 100;
  const viewProjection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
  const size = 64, mask = new Uint8Array(size * size);
  for (let y = 26; y < 38; y++) for (let x = 26; x < 38; x++) mask[y * size + x] = 1;
  const { result, stats } = liftRegion({
    centers: Float32Array.from(centers), alphas: Float32Array.from(alphas), radii: Float32Array.from(radii),
    viewProjection, mask, width: size, height: size, bbox: [26 / 64, 26 / 64, 38 / 64, 38 / 64], class: "Floater",
  });
  const selected = Array.from(result.indices);
  assert.ok(selected.includes(floater));
  assert.ok(!selected.includes(hidden));
  assert.ok(!selected.includes(outside));
  assert.ok(selected.filter(i => i < wallCount).length > 0);
  assert.equal(result.detached[selected.indexOf(floater)], 1);
  for (let i = objectStart; i < objectEnd; i++) {
    assert.ok(selected.includes(i));
    assert.equal(result.detached[selected.indexOf(i)], 0);
  }
  assert.equal(stats.detached, 1);
  assert.ok(Math.abs(stats.backgroundDepth - 10) < 1e-3);
  assert.throws(() => liftRegion({ centers: new Float32Array(3), alphas: new Float32Array(2), radii: new Float32Array(2),
    viewProjection, mask, width: size, height: size, bbox: [0, 0, 1, 1], class: "Floater" }), /inconsistent/);
});
