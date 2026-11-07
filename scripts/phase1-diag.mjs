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
// projected screen bbox of the helper wireframe (from scene graph) vs bbox of tint on/off pixel diff
const projBox = () => page.evaluate(() => { const { viewer, camera, splat, THREE } = window.__sl; splat.updateMatrixWorld(true); const h = viewer.clusterObbHelper; h.updateMatrixWorld(true); const p = h.geometry.attributes.position; const W = 400, H = 300; let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; const v = new THREE.Vector3(); for (let i=0;i<p.count;i++){ v.fromBufferAttribute(p,i).applyMatrix4(h.matrixWorld).project(camera); const x=(v.x+1)/2*W, y=(1-v.y)/2*H; x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);} return [x0|0,y0|0,x1|0,y1|0]; });
const longSettle = () => page.waitForTimeout(6000);
await page.evaluate(() => window.__sl.inject("A", [0.3, 0.3, 0.7, 0.7])); await longSettle();
for (const [name, fn] of [
  ["id", () => {}],
  ["rotY30", () => { const { splat, THREE } = window.__sl; splat.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI/6)); }],
  ["transX0.5", () => { window.__sl.splat.position.x += 0.5; }],
]) {
  console.log("step", name);
  await page.evaluate(fn); await longSettle();
  await tintOff(); await longSettle(); const off = await shot("diag-" + name + "-off");
  await tintOn(); await longSettle(); const on = await shot("diag-" + name + "-on");
  R[name] = { tintDiff: await diff(off, on), helperProj: await projBox() };
  console.log(JSON.stringify(R[name]));
}
fs.writeFileSync(`${OUT}/diag.json`, JSON.stringify(R, null, 2));
console.log("--- tail logs");
await browser.close();
