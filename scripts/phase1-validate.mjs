// Phase 1 browser validation (Playwright, headless Chrome + SwiftShader).
// Usage: node scripts/phase1-validate.mjs   (vite dev server must be on :5199)
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.APPDATA + "/npm/node_modules/@playwright/cli/node_modules/playwright");
const OUT = "docs/phase1-screenshots";
fs.mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:5199/";
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__sl?.splat?.numSplats > 0, null, { timeout: 120000 }).catch(() => {});
const ready = await page.evaluate(() => ({ has: !!window.__sl, n: window.__sl?.splat?.numSplats }));
console.log("ready", ready);
if (!ready.n) { console.log(logs.slice(-15).join("\n")); await browser.close(); process.exit(1); }
await page.waitForTimeout(3000);

async function shot(name) {
  const url = await page.evaluate(() => window.__sl.capture());
  const b64 = url.split(",")[1]; fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, "base64")); return b64;
}
async function diff(aB64, bB64) {
  return page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = (i) => { const k = document.createElement("canvas"); k.width = i.width; k.height = i.height; const g = k.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const da = c(ia), db = c(ib); let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let p = 0; p < da.length; p += 4) {
      if (Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]) > 30) {
        n++; const q = p / 4, x = q % ia.width, y = (q / ia.width) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return { n, bbox: n ? [x0, y0, x1, y1] : null };
  }, [aB64, bB64]);
}
// CPU ground truth: splat centres inside the world-space OBB (as fitted).
const cpuCountWorld = () => page.evaluate(() => {
  const { splat, THREE, lastFit } = window.__sl; splat.updateMatrixWorld(true);
  const o = lastFit.world, inv = new THREE.Matrix4().compose(o.position, o.quaternion, new THREE.Vector3(1, 1, 1)).invert();
  const h = o.size.clone().multiplyScalar(0.5); let n = 0; const v = new THREE.Vector3();
  splat.forEachSplat((i, c) => { v.copy(c).applyMatrix4(splat.matrixWorld).applyMatrix4(inv); if (Math.abs(v.x) <= h.x && Math.abs(v.y) <= h.y && Math.abs(v.z) <= h.z) n++; });
  return n;
});
// Splat-local OBB vs splat-local centres: invariant under any splat transform.
const cpuCountLocal = () => page.evaluate(() => {
  const { splat, THREE, lastFit } = window.__sl;
  const o = lastFit.local, inv = new THREE.Matrix4().compose(o.position, o.quaternion, new THREE.Vector3(1, 1, 1)).invert();
  const h = o.size.clone().multiplyScalar(0.5); let n = 0; const v = new THREE.Vector3();
  splat.forEachSplat((i, c) => { v.copy(c).applyMatrix4(inv); if (Math.abs(v.x) <= h.x && Math.abs(v.y) <= h.y && Math.abs(v.z) <= h.z) n++; });
  return n;
});
const info = () => page.evaluate(() => { const { splat, lastFit } = window.__sl; return { pos: splat.position.toArray(), quat: splat.quaternion.toArray(), method: lastFit?.method, npts: lastFit?.points.length, wpos: lastFit?.world.position.toArray(), wsize: lastFit?.world.size.toArray(), lpos: lastFit?.local.position.toArray() }; });
const tintOff = () => page.evaluate(() => { window.__sl.viewer.clusterTint.setHovered(null); });
const tintOn = () => page.evaluate(() => { window.__sl.viewer.clusterTint.setHovered(window.__sl.lastFit.local); });
const settle = () => page.waitForTimeout(1500);
const R = {};

console.log("step baseline");
const base = await shot("00-baseline"); R.baseInfo = await info();

console.log("step A");
const fitA = await page.evaluate(() => !!window.__sl.inject("A", [0.3, 0.3, 0.7, 0.7]));
R.A_inject = fitA; await settle();
if (!fitA) { console.log("inject produced no fit"); console.log(logs.slice(-15).join("\n")); await browser.close(); process.exit(2); }
R.A_info = await info(); R.A_cpuWorld = await cpuCountWorld(); R.A_cpuLocal = await cpuCountLocal();
const a = await shot("A-basic-highlight"); R.A_diffVsBaseline = await diff(base, a);

// B: current transform: local position pushed through matrixWorld must equal world fit position
R.B = await page.evaluate(() => { const { splat, lastFit } = window.__sl; const p = lastFit.local.position.clone().applyMatrix4(splat.matrixWorld); return { fromLocal: p.toArray(), world: lastFit.world.position.toArray(), err: p.distanceTo(lastFit.world.position) }; });

console.log("step C");
await page.evaluate(() => { window.__sl.splat.position.x += 0.5; }); await settle();
R.C_cpuLocal = await cpuCountLocal(); R.C_cpuWorldStale = await cpuCountWorld();
const c = await shot("C-translated"); R.C_diffVsA = await diff(a, c);
await tintOff(); await settle(); const cOff = await shot("C-translated-off"); await tintOn(); await settle();
R.C_tintDiff = await diff(cOff, c);

console.log("step D");
await page.evaluate(() => { const { splat, THREE } = window.__sl; splat.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)); }); await settle();
R.D_cpuLocal = await cpuCountLocal();
const d = await shot("D-rotated");
await tintOff(); await settle(); const dOff = await shot("D-rotated-off"); await tintOn(); await settle();
R.D_tintDiff = await diff(dOff, d);
R.D_helper = await page.evaluate(() => { const { viewer, splat } = window.__sl; return { parentIsSplat: viewer.clusterObbHelper.parent === splat }; });

console.log("step E");
R.E = await page.evaluate(async () => {
  const { splat } = window.__sl; let n = 0; const orig = splat.updateVersion.bind(splat); splat.updateVersion = () => { n++; return orig(); };
  await new Promise((r) => setTimeout(r, 1000)); const idle = n; n = 0;
  splat.position.x += 0.1; await new Promise((r) => setTimeout(r, 1000)); const moved = n; splat.updateVersion = orig;
  return { updateVersionIdle1s: idle, updateVersionAfterMove1s: moved };
});

console.log("step F");
R.F = [];
let prev = await shot("F-pre");
for (const [i, box] of [[0.1, 0.1, 0.5, 0.5], [0.4, 0.5, 0.8, 0.9], [0.2, 0.4, 0.6, 0.6]].entries()) {
  const ok = await page.evaluate(([l, b]) => !!window.__sl.inject(l, b), ["F" + i, box]).catch((e) => String(e)); await settle();
  const s = await shot("F" + i);
  R.F.push({ box, ok, cpuLocal: ok === true ? await cpuCountLocal() : null, helpers: await page.evaluate(() => window.__sl.splat.children.filter((x) => x.type === "LineSegments").length), diffVsPrev: await diff(prev, s), info: await info() });
  prev = s;
}
R.perf = logs.filter((l) => l.startsWith("[OBB]"));
R.depthOrRay = logs.filter((l) => /Depth|Raycast|Adaptive/i.test(l)).slice(-4);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 2));
console.log("--- tail logs"); console.log(logs.slice(-8).join("\n"));
await browser.close();
