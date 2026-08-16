#!/usr/bin/env python3
"""Produce the delivered disturbance layers this app preloads.

The viewer computes nothing. It shows layers a verifier produced and stands
behind. This is what produces them, and it does so without an account of any
kind: scenes are found through Element 84's public Earth Search catalogue and
pixels are read straight out of the Sentinel-2 L2A cloud-optimised GeoTIFFs on
AWS Open Data, both of which answer anonymous requests.

    python3 scripts/build-bundle.py --config docs/blackfeet-rp3.config.json

What it writes into public/bundle: one classified GeoTIFF per delta per period,
carrying class numbers 0 to 3, and a manifest describing them. Areas in the
manifest are measured off the rasters it just wrote, never asserted by the
config, because a manifest that disagrees with its own raster is worse than no
manifest.

The processing follows the SOP and the browser tool it accompanies, so a client
comparing the two sees the same method:

  radiometry   DN / 10000, with the +1000 DN baseline offset removed from any
               scene the catalogue reports still carrying it, read per scene
               rather than inferred from its date
  cloud        OmniCloudMask, a segmentation model, with snow, saturated and
               no-data taken from the Sen2Cor scene classification
  compositing  per-pixel median over surviving observations
  indices      NDVI (B8, B4), NDMI (B8, B11), NBR (B8A, B12)
  deltas       dNDVI and dNDMI pre minus post, dNBR post minus pre
  water        masked at the delta stage, from SCL, majority across the window
  grid         the scenes' own UTM at 20 m, so an area is a pixel count times a
               constant and no reprojection touches a number

Needs rasterio, numpy and onnxruntime, and the ONNX models produced by
scripts/export-cloud-model.py. None of that ships with the app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import calculate_default_transform, reproject
from rasterio.windows import from_bounds as window_from_bounds

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / ".cache" / "cloud-model"

# Concurrent range requests. The reads are against one S3 host and each is a
# few tens of kilobytes, so this is bounded by round trips rather than
# bandwidth: measured at sixteen, a block of fifty-three overpasses spent
# ninety seconds waiting and thirty inferring.
READ_WORKERS = int(os.environ.get('BUNDLE_READ_WORKERS', 32))

# How GDAL reads a COG over HTTP. Without these it re-fetches headers on every
# open, and there are two per observation per block.
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "100000000")
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", "200000000")

EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"

SCALE = 20  # metres, the SOP's scale for the histogram and the area reductions
BLOCK = 512
SCALE_DIVISOR = 10000
BOA_OFFSET = 1000
MIN_STABLE_SCENES = 4

# Sen2Cor scene classification, for the three things the model has no class for.
SCL_NODATA, SCL_SATURATED, SCL_WATER, SCL_SNOW = 0, 1, 6, 11

ASSETS = ["red", "green", "nir", "nir08", "swir16", "swir22", "scl"]

DELTAS = {
    "dNDVI": {"direction": "pre-minus-post", "bands": ("nir", "red")},
    "dNDMI": {"direction": "pre-minus-post", "bands": ("nir", "swir16")},
    "dNBR": {"direction": "post-minus-pre", "bands": ("nir08", "swir22")},
}


# ---------------------------------------------------------------------------
# Catalogue


def search(bbox, start, end, max_cloud):
    """Every overpass in the window, folded to one entry per datatake.

    MGRS tiles overlap, so near a zone boundary one overpass is published
    twice, and every 2018 to 2021 acquisition also appears under both its
    original and its Collection 1 reprocessing. Either would weight a single
    observation twice in the median.
    """
    features, page = [], None
    while True:
        body = {
            "collections": [COLLECTION],
            "bbox": bbox,
            "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lte": max_cloud}},
            "limit": 100,
        }
        if page:
            body["next"] = page
        request = urllib.request.Request(
            EARTH_SEARCH,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        payload = json.load(urllib.request.urlopen(request))
        features.extend(payload.get("features", []))
        links = {link.get("rel"): link for link in payload.get("links", [])}
        token = links.get("next", {}).get("body", {}).get("next")
        if not token or len(features) >= 400:
            break
        page = token

    by_datatake = defaultdict(list)
    for item in features:
        properties = item["properties"]
        key = properties.get("s2:datatake_id") or properties.get("datetime")
        by_datatake[key].append(item)

    observations = []
    for key, items in by_datatake.items():
        # Higher processing baseline wins where the same overpass was
        # reprocessed, so one calibration reaches the median.
        items.sort(
            key=lambda i: str(i["properties"].get("s2:processing_baseline", "")),
            reverse=True,
        )
        best = items[0]["properties"].get("s2:processing_baseline")
        kept = [i for i in items if i["properties"].get("s2:processing_baseline") == best]
        observations.append(
            {
                "id": key,
                "datetime": items[0]["properties"]["datetime"],
                "cloud": items[0]["properties"].get("eo:cloud_cover", 100),
                "epsg": items[0]["properties"].get("proj:epsg"),
                "offsetApplied": bool(
                    items[0]["properties"].get("earthsearch:boa_offset_applied")
                ),
                "scenes": kept,
            }
        )
    observations.sort(key=lambda o: o["datetime"])
    return observations


def href(scene, asset):
    url = scene["assets"][asset]["href"]
    return url.replace("s3://", "https://s3.us-west-2.amazonaws.com/")


# ---------------------------------------------------------------------------
# Grid


def utm_epsg(lon, lat):
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def build_grid(bbox, epsg):
    """A whole number of 20 m pixels, snapped, so reads sample rather than
    resample and a hectare is a pixel count."""
    from rasterio.warp import transform_bounds

    west, south, east, north = transform_bounds("EPSG:4326", f"EPSG:{epsg}", *bbox)
    west = math.floor(west / SCALE) * SCALE
    south = math.floor(south / SCALE) * SCALE
    east = math.ceil(east / SCALE) * SCALE
    north = math.ceil(north / SCALE) * SCALE
    width = int((east - west) / SCALE)
    height = int((north - south) / SCALE)
    return {
        "epsg": epsg,
        "transform": from_origin(west, north, SCALE, SCALE),
        "width": width,
        "height": height,
        "bounds": (west, south, east, north),
    }


def blocks_of(grid):
    for top in range(0, grid["height"], BLOCK):
        for left in range(0, grid["width"], BLOCK):
            yield {
                "x": left,
                "y": top,
                "width": min(BLOCK, grid["width"] - left),
                "height": min(BLOCK, grid["height"] - top),
            }


def block_bounds(grid, block):
    west, north = grid["transform"] * (block["x"], block["y"])
    east, south = grid["transform"] * (
        block["x"] + block["width"],
        block["y"] + block["height"],
    )
    return west, south, east, north


# ---------------------------------------------------------------------------
# Reading


class Datasets:
    """Open COGs once for the whole run, not once per block.

    Opening a cloud-optimised GeoTIFF over HTTP costs round trips for the
    header and the tile index before a single pixel is read, and this run
    touches the same few hundred files for every one of a hundred and fifty
    blocks. Re-opening them each time made the header traffic dwarf the pixel
    traffic: measured, four minutes a block, against fifty seconds when the
    handles are held.

    A rasterio dataset is not safe to use from two threads at once, so each
    carries its own lock. Different files still proceed in parallel, which is
    where the concurrency actually is: there are hundreds of files and sixteen
    workers, so two threads rarely want the same one.
    """

    def __init__(self):
        import threading

        self._lock = threading.Lock()
        self._open = {}
        self._threading = threading

    def use(self, url):
        # Opened outside the lock, deliberately. Holding it across the open
        # would serialise several hundred round trips behind one another, which
        # is worse than the problem this cache exists to solve: measured, five
        # minutes for a four-block area against fifty seconds. Two threads
        # racing on the same file simply open it twice and one handle is
        # closed, which costs one request, once.
        entry = self._open.get(url)
        if entry is not None:
            return entry

        opened = (rasterio.open(url), self._threading.Lock())
        with self._lock:
            existing = self._open.get(url)
            if existing is not None:
                opened[0].close()
                return existing
            self._open[url] = opened
            return opened

    def close(self):
        for dataset, _ in self._open.values():
            try:
                dataset.close()
            except Exception:
                pass
        self._open.clear()

    def __len__(self):
        return len(self._open)


DATASETS = Datasets()


def read_asset(scene, asset, grid, block):
    """One band of one scene over one block, on the working grid.

    boundless, because a block near the edge of an MGRS tile is partly outside
    it, and the fill is the same no-data sentinel the reflectance bands use.
    """
    bounds = block_bounds(grid, block)
    src, lock = DATASETS.use(href(scene, asset))
    with lock:
        window = window_from_bounds(*bounds, transform=src.transform)
        data = src.read(
            1,
            window=window,
            out_shape=(block["height"], block["width"]),
            boundless=True,
            fill_value=0,
            resampling=Resampling.nearest,
        )
    return data.astype(np.float32)


def read_observation(observation, grid, block):
    """Every band of one overpass, its tiles mosaicked, first with data wins."""
    merged = {}
    for asset in ASSETS:
        stack = None
        for scene in observation["scenes"]:
            if scene["properties"].get("proj:epsg") != grid["epsg"]:
                continue
            data = read_asset(scene, asset, grid, block)
            stack = data if stack is None else np.where(stack == 0, data, stack)
        merged[asset] = stack if stack is not None else np.zeros(
            (block["height"], block["width"]), np.float32
        )
    return merged


def read_block(observations, grid, block):
    """Every band of every overpass over one block, read concurrently.

    Read one at a time this cost three and a half minutes a block and would
    have been nine hours over this ROI, essentially all of it spent waiting on
    round trips rather than on pixels: a block is a few hundred kilobytes and
    a hundred and fifty separate requests. The work is IO, so threads are the
    right tool and the GIL is not in the way.
    """
    from concurrent.futures import ThreadPoolExecutor

    empty = np.zeros((block["height"], block["width"]), np.float32)
    results = [{asset: empty.copy() for asset in ASSETS} for _ in observations]

    def one(task):
        index, asset, scene = task
        return index, asset, read_asset(scene, asset, grid, block)

    tasks = []
    for index, observation in enumerate(observations):
        for scene in observation["scenes"]:
            if scene["properties"].get("proj:epsg") != grid["epsg"]:
                continue
            for asset in ASSETS:
                tasks.append((index, asset, scene))

    with ThreadPoolExecutor(max_workers=READ_WORKERS) as pool:
        for index, asset, data in pool.map(one, tasks):
            # Tiles of one overpass are mosaicked here, first with data wins.
            # They are cut from one continuous swath, so in the overlap they
            # hold the same measurement on two grids and there is nothing to
            # choose between them.
            current = results[index][asset]
            results[index][asset] = np.where(current == 0, data, current)

    return results


# ---------------------------------------------------------------------------
# Cloud


class CloudModel:
    """OmniCloudMask v4, the ensemble, run over each block.

    Chosen over the scene classification because what SCL lets through is thin
    cloud edges and cloud shadow, and in a pre-post delta both read as canopy
    loss. Measured on a 61.7 percent cloudy overpass of this ROI, the model
    called 11.4 percent of a block cloud or shadow where SCL called it clear,
    against 0.75 percent the other way.
    """

    def _init_sessions(self):
        import onnxruntime as ort

        paths = sorted(MODELS.glob("ocm-v4-*.onnx"))
        if len(paths) != 2:
            sys.exit(
                f"Expected two ONNX models in {MODELS}, found {len(paths)}.\n"
                "Run: python3 scripts/export-cloud-model.py"
            )
        self.sessions = [
            ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
            for p in paths
        ]

    @staticmethod
    def _normalise(bands):
        """The model's own per-band, per-patch z-score, nodata left at zero.

        An additive offset cancels exactly here, so the +1000 DN baseline
        offset cannot move this mask whether or not it has been corrected.
        """
        out = np.zeros(bands.shape, np.float32)
        for index, band in enumerate(bands):
            valid = band != 0
            if not valid.any():
                continue
            values = band[valid]
            deviation = values.std() or 1.0
            out[index][valid] = (values - values.mean()) / deviation
        return out

    def __init__(self, factor=1):
        self.factor = factor
        self._init_sessions()

    def keep(self, block_data, reject_snow=True):
        """1 where the observation is usable at that pixel."""
        red, green, nir08 = block_data["red"], block_data["green"], block_data["nir08"]
        full_height, full_width = red.shape

        # The mask may be decided on a coarser grid than the analysis.
        #
        # Cloud and its shadow are large objects and the model is trained from
        # 10 to 50 m, so running it at 40 m rather than 20 m is inside its
        # range and costs a sixth of the time: 235 ms against 1,382 ms per
        # overpass on one block. It is not free. Measured on a 61.7 percent
        # cloudy overpass of this ROI, the keep-or-discard decision changes on
        # 5.4 percent of pixels, almost all at cloud edges where the averaging
        # blurs, and the coarser mask is the more permissive of the two. That
        # difference then passes through a median over every clear look, so it
        # moves the composite by much less than it moves one scene.
        if self.factor > 1:
            red = self._shrink(red, self.factor)
            green = self._shrink(green, self.factor)
            nir08 = self._shrink(nir08, self.factor)

        height, width = red.shape
        # The encoder halves the grid five times, so both edges must divide by 32.
        padded_h = max(32, math.ceil(height / 32) * 32)
        padded_w = max(32, math.ceil(width / 32) * 32)

        stack = np.zeros((3, padded_h, padded_w), np.float32)
        stack[0, :height, :width] = red
        stack[1, :height, :width] = green
        stack[2, :height, :width] = nir08
        model_input = self._normalise(stack)[None, ...]

        summed = None
        for session in self.sessions:
            logits = session.run(None, {"input": model_input})[0]
            summed = logits if summed is None else summed + logits
        classes = summed.argmax(axis=1)[0][:height, :width]

        if self.factor > 1:
            # Back to the analysis grid. Nearest, by repetition: these are class
            # numbers and there is nothing between clear and cloud to interpolate.
            classes = np.repeat(
                np.repeat(classes, self.factor, axis=0), self.factor, axis=1
            )[:full_height, :full_width]
            if classes.shape != (full_height, full_width):
                padded = np.zeros((full_height, full_width), classes.dtype)
                padded[: classes.shape[0], : classes.shape[1]] = classes
                classes = padded

        # The three things the model has no class for and the scene
        # classification is authoritative about, at full resolution.
        scl = block_data["scl"]
        rejected = (scl == SCL_NODATA) | (scl == SCL_SATURATED)
        if reject_snow:
            rejected |= scl == SCL_SNOW
        return ((classes == 0) & ~rejected).astype(np.uint8)

    @staticmethod
    def _shrink(band, factor):
        """Mean of each factor by factor block, the reduction an overview is."""
        height = band.shape[0] // factor * factor
        width = band.shape[1] // factor * factor
        trimmed = band[:height, :width]
        return trimmed.reshape(
            height // factor, factor, width // factor, factor
        ).mean(axis=(1, 3))


# ---------------------------------------------------------------------------
# Compositing and deltas


def composite(observations, grid, block, model, report):
    """Per-pixel median of every observation that survived masking."""
    shape = (block["height"], block["width"])
    stacks = {asset: [] for asset in ASSETS if asset != "scl"}
    waters, valids = [], []

    blocks = read_block(observations, grid, block)

    for index, observation in enumerate(observations):
        data = blocks[index]
        keep = model.keep(data)

        # A zero DN is the no-data sentinel, not a dark pixel: Sen2Cor never
        # writes a genuine zero reflectance. Validity is decided once per
        # observation so an index is never a ratio of two different days.
        complete = np.ones(shape, bool)
        for asset in stacks:
            complete &= data[asset] != 0
        valid = (keep.astype(bool)) & complete

        offset = 0.0 if observation["offsetApplied"] else BOA_OFFSET
        for asset in stacks:
            band = (data[asset] - offset) / SCALE_DIVISOR
            stacks[asset].append(np.where(valid, band, np.nan))

        waters.append(data["scl"] == SCL_WATER)
        valids.append(valid)
        report(index + 1, len(observations))


    counts = np.sum(np.stack(valids), axis=0).astype(np.uint16)
    bands = {
        asset: np.nanmedian(np.stack(values), axis=0)
        for asset, values in stacks.items()
    }

    # A pixel is water where the majority of its valid looks called it water.
    # Not any, which one misclassified scene would punch through, and not all,
    # which one cloudy look over a lake would defeat.
    wet = np.sum(np.stack(waters) & np.stack(valids), axis=0)
    seen = np.sum(np.stack(valids), axis=0)
    water = (seen > 0) & (wet * 2 > seen)
    return bands, counts, water


def normalised(a, b):
    with np.errstate(invalid="ignore", divide="ignore"):
        return (a - b) / (a + b)


def deltas_for(pre, post):
    out = {}
    for name, spec in DELTAS.items():
        first, second = spec["bands"]
        before = normalised(pre[first], pre[second])
        after = normalised(post[first], post[second])
        out[name] = (
            before - after if spec["direction"] == "pre-minus-post" else after - before
        )
    return out


def classify(delta, breaks):
    out = np.zeros(delta.shape, np.uint8)
    with np.errstate(invalid="ignore"):
        out[delta >= breaks["low"]] = 1
        out[delta >= breaks["moderate"]] = 2
        out[delta >= breaks["high"]] = 3
    out[np.isnan(delta)] = 0
    return out


# ---------------------------------------------------------------------------
# Output


def write_layer(path, classes, grid):
    """Write in EPSG:4326, with overviews built by copying.

    Nearest everywhere, and it is not a preference. These are class numbers: an
    averaged overview of a class 1 beside a class 3 is a class 2, a severity
    the analysis never found, and on the map it looks like a smoother, more
    confident result rather than an invented one.
    """
    dst_crs = "EPSG:4326"
    transform, width, height = calculate_default_transform(
        f"EPSG:{grid['epsg']}",
        dst_crs,
        grid["width"],
        grid["height"],
        *grid["bounds"],
    )
    out = np.zeros((height, width), np.uint8)
    reproject(
        source=classes,
        destination=out,
        src_transform=grid["transform"],
        src_crs=f"EPSG:{grid['epsg']}",
        dst_transform=transform,
        dst_crs=dst_crs,
        resampling=Resampling.nearest,
    )

    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "width": width,
        "height": height,
        "crs": dst_crs,
        "transform": transform,
        "nodata": 0,
        "compress": "deflate",
        "predictor": 2,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(out, 1)
        dst.build_overviews([2, 4, 8, 16], Resampling.nearest)
        dst.update_tags(ns="rio_overview", resampling="nearest")
    return out, transform, width, height


def areas_hectares(classes, transform, height):
    """Hectares per class, on the ellipsoid.

    An EPSG:4326 raster has degree pixels, and one at 49 N covers about two
    thirds the ground of one at the equator, so counting pixels and multiplying
    by a constant would overstate a northern project by half.
    """
    lat_step = abs(transform.e)
    lon_step = abs(transform.a)
    north = transform.f
    metres_per_degree_lat = 111_132.0
    areas = [0.0, 0.0, 0.0]
    for row in range(height):
        lat = north - (row + 0.5) * lat_step
        metres_per_degree_lon = 111_320.0 * math.cos(math.radians(lat))
        cell = (lat_step * metres_per_degree_lat) * (lon_step * metres_per_degree_lon)
        line = classes[row]
        for value in (1, 2, 3):
            areas[value - 1] += int(np.count_nonzero(line == value)) * cell
    return [round(a / 10_000.0, 1) for a in areas]


# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", default="public/bundle")
    parser.add_argument("--max-cloud", type=float, default=60)
    parser.add_argument(
        "--mask-scale",
        type=int,
        default=40,
        help="metres the cloud model decides on; 20 matches the analysis grid "
        "exactly and costs about six times as much",
    )
    parser.add_argument(
        "--limit-blocks",
        type=int,
        default=0,
        help="stop after this many blocks, for a smoke run over a real area",
    )
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    bbox = config["roi"]
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    model = CloudModel(factor=max(1, round(args.mask_scale / SCALE)))
    warnings = list(config.get("warnings", []))
    periods_out = []

    for period in config["periods"]:
        print(f"\n=== {period['id']} ===")
        pre = search(bbox, period["preStart"], period["preEnd"], args.max_cloud)
        post = search(bbox, period["postStart"], period["postEnd"], args.max_cloud)
        print(f"  {len(pre)} pre-period and {len(post)} post-period overpasses")
        if not pre or not post:
            sys.exit(f"{period['id']}: a window returned no scenes.")

        for label, observations in (("pre", pre), ("post", post)):
            if len(observations) < MIN_STABLE_SCENES:
                warnings.append(
                    f"{period['id']}: the {label} window kept only "
                    f"{len(observations)} overpass(es). The SOP puts the median's "
                    f"stability floor at {MIN_STABLE_SCENES}, and below it the "
                    "composite can move with a single observation."
                )

        epsg = max(
            {o["epsg"] for o in pre + post if o["epsg"]},
            key=lambda e: sum(1 for o in pre + post if o["epsg"] == e),
        )
        grid = build_grid(bbox, epsg)
        print(f"  grid EPSG:{epsg}, {grid['width']} x {grid['height']} px at {SCALE} m")

        uncorrected = [o for o in pre + post if not o["offsetApplied"]]
        if uncorrected:
            warnings.append(
                f"{len(uncorrected)} overpass(es) still carried the +1000 DN "
                "baseline offset and were corrected before compositing."
            )

        classified = {name: np.zeros((grid["height"], grid["width"]), np.uint8)
                      for name in DELTAS}
        observed = thin = 0

        # Each block's result is kept on disk as it is finished.
        #
        # This run is hours long over a large ROI, and anything that interrupts
        # it, a laptop sleeping, a session ending, a network stall, would
        # otherwise throw away every block already paid for. Restarting picks
        # up where it stopped. The grid is derived deterministically from the
        # ROI and the chosen zone, so a block index means the same thing across
        # runs; a config change means a new work directory.
        # Keyed by everything that decides what a block contains, not by the
        # period's name. Keyed by name alone, a run over a different ROI would
        # silently load the previous run's blocks into the new grid and produce
        # a layer assembled from two different places.
        identity = json.dumps(
            {
                "roi": bbox,
                "epsg": epsg,
                "size": [grid["width"], grid["height"]],
                "bounds": grid["bounds"],
                "windows": [
                    period["preStart"], period["preEnd"],
                    period["postStart"], period["postEnd"],
                ],
                "breaks": period["breaksByDelta"],
                "maxCloud": args.max_cloud,
                "maskScale": args.mask_scale,
            },
            sort_keys=True,
        )
        stamp = hashlib.sha256(identity.encode()).hexdigest()[:12]
        work = ROOT / ".cache" / "build" / f"{period['id']}-{stamp}"
        work.mkdir(parents=True, exist_ok=True)

        blocks = list(blocks_of(grid))
        if args.limit_blocks:
            blocks = blocks[: args.limit_blocks]

        done = 0
        for index, block in enumerate(blocks):
            cached = work / f"block-{index:05d}.npz"
            if cached.exists():
                held = np.load(cached)
                for name in DELTAS:
                    classified[name][
                        block["y"] : block["y"] + block["height"],
                        block["x"] : block["x"] + block["width"],
                    ] = held[name]
                observed += int(held["observed"])
                thin += int(held["thin"])
                done += 1
                continue
            def report(done, total, index=index):
                print(
                    f"\r  block {index + 1}/{len(blocks)}  overpass {done}/{total}   ",
                    end="",
                    flush=True,
                )

            pre_bands, pre_counts, pre_water = composite(pre, grid, block, model, report)
            post_bands, post_counts, post_water = composite(post, grid, block, model, report)

            block_deltas = deltas_for(pre_bands, post_bands)
            water = pre_water | post_water
            for name, delta in block_deltas.items():
                delta[water] = np.nan
                patch = classify(delta, period["breaksByDelta"][name])
                classified[name][
                    block["y"] : block["y"] + block["height"],
                    block["x"] : block["x"] + block["width"],
                ] = patch

            seen = np.minimum(pre_counts, post_counts)
            block_observed = int(np.count_nonzero(seen > 0))
            block_thin = int(np.count_nonzero((seen > 0) & (seen < MIN_STABLE_SCENES)))
            observed += block_observed
            thin += block_thin

            np.savez_compressed(
                cached,
                observed=block_observed,
                thin=block_thin,
                **{
                    name: classified[name][
                        block["y"] : block["y"] + block["height"],
                        block["x"] : block["x"] + block["width"],
                    ]
                    for name in DELTAS
                },
            )
            done += 1

        print()
        print(f"  {done} block(s) held in {work}")
        if observed and thin / observed >= 0.01:
            warnings.append(
                f"{100 * thin / observed:.1f} percent of observed pixels had fewer "
                f"than {MIN_STABLE_SCENES} clear looks in one of the two windows."
            )

        # The area the figures below are a share of: pixels with at least one
        # clear look in both windows, on the 20 m grid.
        analysed_ha = observed * (SCALE * SCALE) / 10_000.0

        layers = []
        for name in DELTAS:
            path = output / f"{period['id']}-{name}.tif"
            drawn, transform, width, height = write_layer(path, classified[name], grid)
            areas = areas_hectares(drawn, transform, height)
            share = sum(areas) / analysed_ha if analysed_ha else 0
            print(
                f"  {path.name}: {width} x {height} px, "
                f"{sum(areas):,.1f} ha flagged {areas}, {100 * share:.1f} percent"
            )

            # A screening layer that flags a tenth of everything it looked at is
            # answering a different question from the one it was asked. Over an
            # area of cropland and grassland, a summer-to-summer difference
            # crosses the SOP's low break on phenology alone, and dNBR crosses
            # it most easily. Saying so in the delivery is cheaper than a client
            # reading 139,000 hectares of "burn severity" and believing it.
            if share > 0.10:
                warnings.append(
                    f"{period['id']} {name} flags {100 * share:.1f} percent of the "
                    f"{analysed_ha:,.0f} ha analysed. A share that large over an area "
                    "that is not wholly forest is more consistent with seasonal "
                    "difference between the two windows than with disturbance. Clip to "
                    "the project boundary and re-read the histogram before quoting it."
                )
            layers.append(
                {
                    "id": name,
                    "label": config["labels"][name],
                    "cog": path.name,
                    "breaks": period["breaksByDelta"][name],
                    "areasHa": areas,
                    "justification": period.get("justifications", {}).get(name),
                }
            )

        periods_out.append(
            {
                "id": period["id"],
                "preStart": period["preStart"],
                "preEnd": period["preEnd"],
                "postStart": period["postStart"],
                "postEnd": period["postEnd"],
                "layers": layers,
            }
        )

    bundle = {
        "version": 1,
        "project": config["project"],
        "client": config["client"],
        "boundary": config.get("boundary"),
        "boundaryAreaHa": config.get("boundaryAreaHa"),
        "analysedAreaHa": round(analysed_ha, 1),
        "periods": periods_out,
        "provenance": {
            "script": "scripts/build-bundle.py",
            "collection": f"{COLLECTION} (Sentinel-2 L2A COGs on AWS Open Data)",
            "cloudRemoval": (
                "OmniCloudMask v4 ensemble on red, green and B8A decided at "
                f"{args.mask_scale} m; snow, saturated and no-data from the "
                "Sen2Cor scene classification"
            ),
            "scale": SCALE,
            "runDate": datetime.now(timezone.utc).date().isoformat(),
            "analyst": config["provenance"]["analyst"],
        },
        "warnings": warnings,
    }

    manifest = output / "manifest.json"
    manifest.write_text(json.dumps(bundle, indent=2) + "\n")
    print(f"\nWrote {manifest}")
    missing = [
        f"{p['id']} {l['id']}"
        for p in periods_out
        for l in p["layers"]
        if not l["justification"]
    ]
    if missing:
        print(
            f"  No justification recorded for {', '.join(missing)}. The viewer "
            "will say these figures cannot be read as SOP-compliant."
        )


if __name__ == "__main__":
    main()
