// Loads the built bundle the way GeoLibre's loader does and asserts the plugin
// contract, plus the delivered bundle if one is present.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stub = () => ({ className: "", style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null });
const define = (n, v) => Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true });
globalThis.window = globalThis; globalThis.self = globalThis;
define("location", new URL("https://example.invalid/"));
define("navigator", { userAgent: "node" });
globalThis.document = { createElement: stub, createElementNS: stub, head: { appendChild() {} }, body: { appendChild() {} }, adoptedStyleSheets: [], querySelector: () => null, addEventListener() {} };
globalThis.CSSStyleSheet = class { replaceSync() {} };
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };

const plugin = (await import(join(root, "dist/index.js"))).default;
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.ok(plugin, "the bundle has no default export");
assert.equal(typeof plugin.activate, "function");
assert.equal(typeof plugin.deactivate, "function");
assert.equal(plugin.id, manifest.id, "plugin id does not match plugin.json");
assert.equal(plugin.version, manifest.version, "plugin version does not match plugin.json");
assert.equal(manifest.version, pkg.version, "plugin.json and package.json versions differ");

// This app must never carry an analysis control. If one appears, the delivered
// layers stop being the record and become something a client can re-derive.
const code = readFileSync(join(root, "dist/index.js"), "utf8");
for (const term of ["Cloud ceiling", "Run check", "Severity thresholds"]) {
  assert.ok(
    !code.includes(term),
    `"${term}" suggests an analysis control leaked into the client viewer`,
  );
}

const bundlePath = join(root, "public/bundle/manifest.json");
let bundleNote = "no bundle in public/bundle";
if (existsSync(bundlePath)) {
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  assert.equal(bundle.version, 1, "bundle format version must be 1");
  assert.ok(bundle.periods?.length, "bundle carries no periods");
  for (const period of bundle.periods) {
    for (const layer of period.layers) {
      assert.ok(layer.cog, `${period.id} ${layer.id} names no raster`);
      assert.ok(existsSync(join(root, "public/bundle", layer.cog)), `${layer.cog} is missing`);
      assert.equal(layer.areasHa?.length, 3, `${layer.id} needs three class areas`);
    }
  }
  const layers = bundle.periods.reduce((n, p) => n + p.layers.length, 0);
  bundleNote = `${bundle.periods.length} period(s), ${layers} layer(s)${bundle.sample ? ", SAMPLE" : ""}`;
}

console.log("smoke test passed");
console.log(`  plugin   ${plugin.id} v${plugin.version}`);
console.log(`  bundle   ${bundleNote}`);
console.log(`  size     ${(readFileSync(join(root, "dist/index.js")).length / 1024).toFixed(0)} kB`);
