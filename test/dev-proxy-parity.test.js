import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression: `npm run dev` previously had no /api/ncbi route, so Vite's SPA
// fallback returned index.html. Every redirect in netlify.toml must have a
// matching dev route in vite.config.js.
test("vite.config.js serves every /api route declared in netlify.toml", async () => {
  const toml = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  const vite = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const routes = [...toml.matchAll(/from\s*=\s*"(\/api\/[a-z]+)"/g)].map(m => m[1]);
  assert.ok(routes.includes("/api/ncbi"));
  for (const route of routes) assert.ok(vite.includes(`'${route}'`), `missing dev route ${route}`);
});

// Regression: a default export makes Netlify treat the file as a v2 function
// (Request => Response). `export default { handler }` then crashes with
// "TypeError: D.handler is not a function". Keep functions on the v1 named export.
test("Netlify functions use only the named `handler` export (no default export)", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../netlify/functions/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".js") && !f.startsWith("_"))) {
    const src = await readFile(new URL(file, dir), "utf8");
    assert.ok(/export\s+(async\s+function|const)\s+handler/.test(src), `${file} must export handler`);
    assert.ok(!/export\s+default/.test(src), `${file} must not have a default export`);
  }
});
