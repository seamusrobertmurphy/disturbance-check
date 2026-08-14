#!/usr/bin/env node
// Turn Earth Engine exports into a bundle a client's browser can open.
//
// The disturbance layers are produced by the Earth Engine scripts run in QGIS
// or ArcGIS, which export classified GeoTIFFs to Drive at 10 m. Those files are
// not viewable in a browser as they stand: an export over a 50,000 ha project
// is roughly 7000 by 7000 pixels with no internal tiling and no overviews, so a
// viewer would have to fetch the whole thing before drawing a single pixel.
//
// This converts each one to a cloud-optimised GeoTIFF, which is the same
// pixels with an internal tile grid and a pyramid of reduced-resolution copies
// written into the file. A viewer then fetches only the tiles on screen at only
// the resolution the screen can show, which is the same mechanism the Sentinel-2
// archive itself uses.
//
// Usage:
//   node scripts/prepare-bundle.mjs --input <dir of EE exports> --config <json>
//
// The config carries everything the rasters cannot: which windows were
// differenced, which thresholds were applied, the areas, and who ran it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const BUNDLE_DIR = "public/bundle";

function usage(message) {
  console.error(`${message}

Usage:
  node scripts/prepare-bundle.mjs --input <dir> --config <bundle-config.json>

  --input   directory holding the GeoTIFFs exported from Earth Engine
  --config  json describing the run; see docs/bundle-config.example.json
  --output  where to write the bundle (default ${BUNDLE_DIR})
`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) usage(`Malformed argument near "${argv[i]}"`);
    args[key] = argv[i + 1];
  }
  return args;
}

function requireGdal() {
  try {
    const version = execFileSync("gdal_translate", ["--version"], {
      encoding: "utf8",
    }).trim();
    console.log(`Using ${version}`);
  } catch {
    usage(
      "gdal_translate is not on PATH. Install GDAL, or run this from the OSGeo4W shell on Windows, where QGIS already provides it.",
    );
  }
}

/**
 * Match an exported file to the period and delta it belongs to.
 *
 * The Earth Engine scripts name their exports predictably: the multi-period
 * block writes `<RP>_<layer>` and the single-period block writes
 * `dNDVI_canopy_loss_classified` and its siblings. Both are recognised, and
 * anything unrecognised is reported rather than silently skipped, because a
 * layer missing from a client deliverable must not be a silent outcome.
 */
function classify(fileName) {
  const name = basename(fileName).replace(/\.tif{1,2}$/i, "");
  const delta = /dNDVI/i.test(name)
    ? "dNDVI"
    : /dNDMI/i.test(name)
      ? "dNDMI"
      : /dNBR|NDBR/i.test(name)
        ? "dNBR"
        : null;
  if (!delta) return null;
  if (!/classified|_class|_dist/i.test(name) && !/^RP/i.test(name)) return null;

  const period = /^(RP[^_]*)_/i.exec(name)?.[1] ?? "RP1";
  return { period, delta, name };
}

/**
 * Convert to a cloud-optimised GeoTIFF.
 *
 * NEAREST for the overviews, never AVERAGE. These are class numbers, and
 * averaging class 1 with class 3 produces class 2, inventing a moderate
 * severity that the analysis never found. It would be invisible: the raster
 * would look smoother and read as more precise.
 *
 * DEFLATE because the payload is four values over a mostly-masked field, which
 * compresses to a small fraction of the export.
 */
function toCog(input, output) {
  execFileSync(
    "gdal_translate",
    [
      "-of", "COG",
      "-co", "COMPRESS=DEFLATE",
      "-co", "PREDICTOR=2",
      "-co", "BLOCKSIZE=512",
      "-co", "OVERVIEW_RESAMPLING=NEAREST",
      "-co", "RESAMPLING=NEAREST",
      "-a_nodata", "0",
      input,
      output,
    ],
    { stdio: "inherit" },
  );
}

function describe(path) {
  const info = JSON.parse(
    execFileSync("gdalinfo", ["-json", path], { encoding: "utf8" }),
  );
  return {
    size: info.size,
    epsg:
      info.coordinateSystem?.wkt?.match(/ID\["EPSG",(\d+)\]\s*\]?\s*$/)?.[1] ??
      null,
    overviews: info.bands?.[0]?.overviews?.length ?? 0,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.config) usage("Both --input and --config are required.");

const inputDir = resolve(args.input);
const outputDir = resolve(args.output ?? BUNDLE_DIR);
if (!existsSync(inputDir)) usage(`No such directory: ${inputDir}`);

requireGdal();
mkdirSync(outputDir, { recursive: true });

const config = JSON.parse(readFileSync(resolve(args.config), "utf8"));
const exports = readdirSync(inputDir).filter((f) => /\.tif{1,2}$/i.test(f));
if (exports.length === 0) usage(`No GeoTIFFs in ${inputDir}`);

console.log(`Found ${exports.length} GeoTIFF(s) in ${inputDir}`);

const byPeriod = new Map();
const skipped = [];

for (const file of exports.sort()) {
  const match = classify(file);
  if (!match) {
    skipped.push(file);
    continue;
  }
  const cogName = `${match.period}-${match.delta}.tif`;
  const output = join(outputDir, cogName);
  console.log(`  ${file}  ->  ${cogName}`);
  toCog(join(inputDir, file), output);

  const info = describe(output);
  console.log(
    `      ${info.size?.join(" x ")} px, EPSG:${info.epsg ?? "?"}, ${info.overviews} overview level(s)`,
  );
  if (info.overviews === 0) {
    console.warn(
      "      WARNING: no overviews were written. A client will fetch full resolution at every zoom.",
    );
  }

  if (!byPeriod.has(match.period)) byPeriod.set(match.period, []);
  byPeriod.get(match.period).push({ delta: match.delta, cog: cogName });
}

if (skipped.length > 0) {
  console.warn(
    `\nNot recognised as a classified disturbance layer, and left out:\n  ${skipped.join("\n  ")}`,
  );
}

// Assemble the manifest from the config, filling in the rasters just written.
const periods = (config.periods ?? []).map((period) => {
  const written = byPeriod.get(period.id) ?? [];
  const layers = (period.layers ?? []).map((layer) => {
    const found = written.find((entry) => entry.delta === layer.id);
    if (!found) {
      throw new Error(
        `${period.id} ${layer.id} is described in the config but no matching export was found in ${inputDir}.`,
      );
    }
    return { ...layer, cog: found.cog };
  });
  return { ...period, layers };
});

const bundle = {
  version: 1,
  project: config.project,
  client: config.client,
  boundary: config.boundary ?? null,
  boundaryAreaHa: config.boundaryAreaHa ?? null,
  periods,
  provenance: config.provenance,
  warnings: config.warnings ?? [],
};

const manifestPath = join(outputDir, "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`);

console.log(`\nWrote ${manifestPath}`);
console.log(
  `  ${periods.length} period(s), ${periods.reduce((n, p) => n + p.layers.length, 0)} layer(s)`,
);
for (const period of periods) {
  for (const layer of period.layers) {
    const total = layer.areasHa.reduce((a, b) => a + b, 0);
    console.log(
      `    ${period.id} ${layer.id}: ${total.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha flagged`,
    );
  }
}
