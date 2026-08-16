// Loads the built bundle the way GeoLibre's loader does and asserts the plugin
// contract, plus the delivered bundle if one is present.
import assert from "node:assert/strict";
import { fromFile } from "geotiff";
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
  let remote = 0;
  const localLayers = [];
  for (const period of bundle.periods) {
    for (const layer of period.layers) {
      assert.ok(layer.cog, `${period.id} ${layer.id} names no raster`);
      // A layer may ship beside the app or be streamed from a bucket. Only the
      // first kind can be checked from here; the second is checked against the
      // live objects by scripts/prepare-remote-bundle.mjs, which is the only
      // place that can tell whether they are still readable.
      if (/^https?:\/\//i.test(layer.cog)) {
        remote += 1;
      } else {
        assert.ok(existsSync(join(root, "public/bundle", layer.cog)), `${layer.cog} is missing`);
      }
      assert.equal(layer.areasHa?.length, 3, `${layer.id} needs three class areas`);
      localLayers.push({ period: period.id, layer });
    }
  }
  if (remote > 0) {
    assert.ok(
      bundle.expiresAt,
      "layers are held remotely but the bundle names no expiry, so a client meeting a dead link would be shown a network error",
    );
  }
  // The manifest checked against the rasters it describes.
  //
  // This is the failure the shipped sample had: it claimed 1240.5, 318.2 and
  // 402.7 hectares for a raster holding 6132.8, 2383.8 and 4083.7, and the
  // same three figures for all three layers. Nothing on screen looks wrong
  // when a manifest is invented, which is exactly why it has to be checked
  // here. Class presence rather than area, because the area maths belongs in
  // one place and that place is scripts/class-areas.py.
  for (const { period, layer } of localLayers) {
    const tiff = await fromFile(join(root, "public/bundle", layer.cog));
    const image = await tiff.getImage();
    const [band] = await image.readRasters({ interleave: false });
    const present = new Set();
    for (const value of band) if (value >= 1 && value <= 3) present.add(value);
    for (let index = 0; index < 3; index += 1) {
      const claimed = layer.areasHa[index];
      const found = present.has(index + 1);
      assert.ok(
        claimed > 0 === found,
        `${period} ${layer.id} claims ${claimed} ha of class ${index + 1} but the raster ` +
          `${found ? "holds pixels of it" : "holds none"}. The manifest does not describe its own layer.`,
      );
    }
  }

  const layers = bundle.periods.reduce((n, p) => n + p.layers.length, 0);
  bundleNote = `${bundle.periods.length} period(s), ${layers} layer(s)`
    + (remote > 0 ? `, ${remote} remote, expires ${bundle.expiresAt}` : "")
    + (bundle.sample ? ", SAMPLE" : "");
}

console.log("smoke test passed");
console.log(`  plugin   ${plugin.id} v${plugin.version}`);
console.log(`  bundle   ${bundleNote}`);
console.log(`  size     ${(readFileSync(join(root, "dist/index.js")).length / 1024).toFixed(0)} kB`);
