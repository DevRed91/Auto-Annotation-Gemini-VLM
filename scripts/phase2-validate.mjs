// Phase 2 browser validation: deterministic fixtures plus Apartment.sog.
// Playwright is resolved locally, or from PLAYWRIGHT_MODULE for an external install.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.PHASE2_URL ?? "http://127.0.0.1:5199";
const outputPath = path.join(root, "docs/phase2-results.json");
let server;
let browser;

async function waitForServer(url) {
  let lastError;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${lastError ?? "HTTP error"}`);
}

try {
  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    throw new Error(
      "Playwright is required. Install it or set PLAYWRIGHT_MODULE to its module path. " +
      String(error),
    );
  }

  if (!process.env.PHASE2_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5199", "--strictPort", "--no-open"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/phase2.html`);
  }

  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    const entry = { type: message.type(), text: message.text() };
    consoleMessages.push(entry);
    if (message.type() === "error") console.error(`[browser error] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[page error] ${error.message}`);
  });

  await page.goto(`${baseURL}/phase2.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__phase2?.ready === true, null, { timeout: 240000 });
  const report = await page.evaluate(() => window.__phase2.report);
  const consoleErrors = consoleMessages.filter((message) => message.type === "error");
  const failed = report.tests.filter((entry) => !entry.passed);
  const result = {
    environment: {
      url: `${baseURL}/phase2.html`,
      browser: "headless Chromium",
      angle: "SwiftShader",
      viewport: [640, 480],
    },
    ...report,
    consoleMessages,
    pageErrors,
    consoleErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  for (const entry of report.tests) {
    console.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.error ? `\n${entry.error}` : ""}`);
  }
  if (report.performance) console.log(`Performance\n${JSON.stringify(report.performance, null, 2)}`);
  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);

  if (failed.length || report.shaderErrors.length || report.finalGlError !== 0 ||
      consoleErrors.length || pageErrors.length || !report.performance) {
    console.error(JSON.stringify({
      failedTests: failed.length,
      shaderErrors: report.shaderErrors,
      finalGlError: report.finalGlError,
      consoleErrors,
      pageErrors,
      hasPerformance: Boolean(report.performance),
    }, null, 2));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
