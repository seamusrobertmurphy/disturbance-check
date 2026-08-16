#!/usr/bin/env node
// Publish a manifest pointing at layers held in Cloud Storage.
//
// The alternative to scripts/prepare-bundle.mjs. That one takes GeoTIFFs off
// your disk, converts them and commits them next to the app. This one takes
// nothing off your disk: Earth Engine writes cloud-optimised GeoTIFFs straight
// into a bucket, the viewer streams them by range request, and a lifecycle rule
// on the bucket deletes them after seven days. The repository never carries a
// raster and you never handle a download.
//
// What it checks before writing anything, because each of these fails in a way
// the client sees and you do not:
//
//   reachable      the object exists and answers anonymously, since the client
//                  has no Google account
//   range requests a 206 with accept-ranges, or geotiff.js fetches whole
//                  rasters instead of pyramid tiles
//   CORS           the header for the viewer's origin, without which the
//                  browser refuses the read and reports nothing useful
//   overviews      built by copying, not averaging; see check-overviews.py
//   areas          measured off the delivered object, not asserted by the config
//   readable       opened with geotiff.js, the same library the viewer uses
//
// Any failure and no manifest is written. A viewer pointed at layers that half
// work is worse than one that says it has none.
//
// Usage:
//   node scripts/prepare-remote-bundle.mjs \
//     --bucket tuvsud-disturbance-check \
//     --prefix blackfeet-rp3 \
//     --config docs/blackfeet-rp3.config.json

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fromUrl } from "geotiff";

const DEFAULT_OUTPUT = "public/bundle/manifest.json";
const DEFAULT_ORIGIN = "https://seamusrobertmurphy.github.io";
const DEFAULT_DAYS = 7;

function usage(message) {
  console.error(`${message}

Usage:
  node scripts/prepare-remote-bundle.mjs --bucket <name> --prefix <path> --config <json>

  --bucket   Cloud Storage bucket holding the exports
  --prefix   object prefix the Earth Engine script wrote under
  --config   json describing the run; see docs/bundle-config.example.json
  --origin   origin the viewer is served from (default ${DEFAULT_ORIGIN})
  --days     bucket retention, for the expiry note (default ${DEFAULT_DAYS})
  --output   where to write the manifest (default ${DEFAULT_OUTPUT})
  --base     host the objects are served from, if not storage.googleapis.com
             (a custom domain in front of the bucket, or a test server)
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

const args = parseArgs(process.argv.slice(2));
if (!args.bucket || !args.prefix || !args.config) {
  usage("--bucket, --prefix and --config are all required.");
}

const origin = args.origin ?? DEFAULT_ORIGIN;
const days = Number(args.days ?? DEFAULT_DAYS);
const outputPath = resolve(args.output ?? DEFAULT_OUTPUT);
const config = JSON.parse(readFileSync(resolve(args.config), "utf8"));

/** Where the Earth Engine script's toCloudStorage export lands. */
const base = (args.base ?? `https://storage.googleapis.com/${args.bucket}`)
  .replace(/\/+$/, "");

function objectUrl(periodId, deltaId) {
  const name = `${periodId}_${deltaId}_classified.tif`;
  return `${base}/${args.prefix}/${name}`;
}

const failures = [];
function fail(url, message) {
  failures.push(`${url.split("/").pop()}: ${message}`);
}

// ---------------------------------------------------------------------------
// HTTP behaviour, checked as a browser would meet it.

async function checkHttp(url) {
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) {
    fail(url, `HEAD returned ${head.status}. ${
      head.status === 403
        ? "The object is not publicly readable. Re-run scripts/setup-bucket.sh."
        : head.status === 404
          ? "No such object. Check the Earth Engine task finished and wrote this name."
          : ""
    }`.trim());
    return null;
  }

  const bytes = Number(head.headers.get("content-length") ?? 0);
  const created = head.headers.get("last-modified");

  const ranged = await fetch(url, { headers: { Range: "bytes=0-1023" } });
  if (ranged.status !== 206) {
    fail(url, `a range request returned ${ranged.status}, not 206. The viewer would fetch whole rasters.`);
  }
  if (!ranged.headers.get("accept-ranges") && !ranged.headers.get("content-range")) {
    fail(url, "no accept-ranges or content-range header on a partial response.");
  }
  await ranged.arrayBuffer();

  const cors = await fetch(url, { method: "GET", headers: { Origin: origin, Range: "bytes=0-0" } });
  const allowed = cors.headers.get("access-control-allow-origin");
  if (!allowed) {
    fail(url, `no access-control-allow-origin for ${origin}. A browser will refuse to read this. Re-run scripts/setup-bucket.sh.`);
  } else if (allowed !== "*" && allowed !== origin) {
    fail(url, `access-control-allow-origin is "${allowed}", which does not admit ${origin}.`);
  }
  await cors.arrayBuffer();

  return { bytes, created: created ? new Date(created) : null };
}

// ---------------------------------------------------------------------------
// The read path itself, through the library the browser will use.

async function checkGeotiff(url, deltaId) {
  try {
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const levels = await tiff.getImageCount();
    const [west, south, east, north] = image.getBoundingBox();
    if (Math.abs(west) > 180 || Math.abs(north) > 90) {
      fail(url, `bounds read ${[west, south, east, north].join(", ")}, which is a projected CRS. The viewer needs EPSG:4326.`);
      return null;
    }
    if (levels < 2) {
      fail(url, "the file carries no overviews, so the viewer would fetch full resolution at every zoom.");
    }
    return {
      width: image.getWidth(),
      height: image.getHeight(),
      levels: levels - 1,
      bounds: [west, south, east, north],
    };
  } catch (error) {
    fail(url, `geotiff.js could not read it: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------

function python(script, urls, extra = []) {
  const output = execFileSync(
    "python3",
    [join("scripts", script), ...urls, ...extra],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

const expected = [];
for (const period of config.periods ?? []) {
  for (const layer of period.layers ?? []) {
    expected.push({ period, layer, url: objectUrl(period.id, layer.id) });
  }
}
if (expected.length === 0) usage("The config describes no layers.");

console.log(`Checking ${expected.length} object(s) under gs://${args.bucket}/${args.prefix}\n`);

let oldest = null;
for (const entry of expected) {
  const name = entry.url.split("/").pop();
  process.stdout.write(`  ${name}\n`);

  const http = await checkHttp(entry.url);
  if (!http) continue;
  if (http.created && (!oldest || http.created < oldest)) oldest = http.created;
  console.log(`      ${(http.bytes / 1_048_576).toFixed(1)} MB, anonymous read, range and CORS ok`);

  const raster = await checkGeotiff(entry.url, entry.layer.id);
  if (raster) {
    console.log(`      ${raster.width} x ${raster.height} px, ${raster.levels} overview level(s)`);
  }
}

if (failures.length > 0) {
  console.error(`\nRefusing to write a manifest. ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

// Overviews, and the areas, from the objects themselves.
const urls = expected.map((entry) => entry.url);

console.log("\nChecking overview resampling.");

// check-overviews.py exits 1 on any verdict other than "nearest", and also
// dies on an unreadable raster. Those are different problems with different
// fixes, so the verdicts are read rather than inferred from the exit status.
// Reporting "these overviews average" because a read timed out would send
// someone to re-export a file that was fine.
let overviewResults = null;
let overviewCrash = null;
try {
  overviewResults = python("check-overviews.py", urls, ["--json"]);
} catch (error) {
  const text = error.stdout?.toString() ?? "";
  try {
    overviewResults = JSON.parse(text);
  } catch {
    overviewCrash = (error.stderr?.toString() || error.message || "").trim();
  }
}

if (overviewCrash) {
  console.error(
    "\nRefusing to write a manifest: the overview check could not run.\n" +
    "This is a read failure, not a verdict on the overviews.\n\n" +
    `${overviewCrash.split("\n").slice(-3).join("\n")}\n`,
  );
  process.exit(1);
}

for (const result of overviewResults) {
  console.log(`  ${result.source.split("/").pop()}: ${result.verdict}, ${result.blocksExamined} block(s) examined`);
}

const averaged = overviewResults.filter((r) => r.verdict === "averaged");
const bare = overviewResults.filter((r) => r.verdict === "no overviews");

if (averaged.length > 0) {
  console.error(
    "\nRefusing to write a manifest: these overviews invent severity classes.\n" +
    "An overview pixel holds a class absent from the pixels beneath it, which\n" +
    "only interpolation produces. Averaging a class 1 with a class 3 yields a\n" +
    "class 2 the analysis never found, and it is invisible on the map.\n\n" +
    "Earth Engine's COG writer built these, not this repo. Re-export without\n" +
    "cloudOptimized and convert with scripts/prepare-bundle.mjs, which forces\n" +
    "OVERVIEW_RESAMPLING=NEAREST.\n",
  );
  process.exit(1);
}

if (bare.length > 0) {
  console.error(
    "\nRefusing to write a manifest: these rasters carry no overviews, so the\n" +
    "viewer would fetch full resolution at every zoom. Check the export set\n" +
    "cloudOptimized, or convert with scripts/prepare-bundle.mjs.\n",
  );
  process.exit(1);
}

console.log("\nMeasuring severity areas off the delivered objects.");
const measured = python("class-areas.py", urls, ["--json"]).areasHa;
for (const [delta, areas] of Object.entries(measured)) {
  const total = areas.reduce((a, b) => a + b, 0);
  console.log(`  ${delta}: ${total.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha flagged`);
}

// ---------------------------------------------------------------------------
// The manifest.

const created = oldest ?? new Date();
const expiresAt = new Date(created.getTime() + days * 86_400_000);

const periods = (config.periods ?? []).map((period) => ({
  ...period,
  layers: (period.layers ?? []).map((layer) => {
    const areas = measured[layer.id];
    if (!areas) {
      throw new Error(`No measured areas came back for ${period.id} ${layer.id}.`);
    }
    return { ...layer, cog: objectUrl(period.id, layer.id), areasHa: areas };
  }),
}));

const bundle = {
  version: 1,
  project: config.project,
  client: config.client,
  boundary: config.boundary ?? null,
  boundaryAreaHa: config.boundaryAreaHa ?? null,
  periods,
  provenance: config.provenance,
  warnings: config.warnings ?? [],
  expiresAt: expiresAt.toISOString().slice(0, 10),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);

console.log(`\nWrote ${outputPath}`);
console.log(`  ${periods.length} period(s), ${periods.reduce((n, p) => n + p.layers.length, 0)} layer(s), held remotely`);
console.log(`  layers expire ${bundle.expiresAt}, ${days} days after the objects were written`);

const missing = periods.flatMap((p) => p.layers.filter((l) => !l.justification).map((l) => `${p.id} ${l.id}`));
if (missing.length > 0) {
  console.warn(
    `\n  No justification recorded for ${missing.join(", ")}. The viewer will\n` +
    "  print that these figures cannot be read as SOP-compliant until one is\n" +
    "  supplied. Add it to the config and re-run.",
  );
}
