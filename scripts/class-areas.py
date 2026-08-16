#!/usr/bin/env python3
"""Read the severity-class areas off the delivered rasters.

The bundle manifest carries three hectare figures per layer and the viewer
prints them to a client. Earth Engine reports its own figures at the end of the
disturbance-check script, but those describe what Earth Engine computed, not
what was exported, downloaded and converted. The two can differ: the export is
reprojected to EPSG:4326, resampled to a fixed pixel grid, and clipped to the
requested region. What the client's browser draws is this file, so this file is
what the manifest should quote.

Sources may be a directory, individual files, or https URLs. A URL is read
through GDAL's virtual file system, which fetches only the ranges it needs and
writes nothing to disk, so layers held in a Cloud Storage bucket are measured
in place rather than downloaded.

Usage:
    python3 scripts/class-areas.py <dir of GeoTIFFs>
    python3 scripts/class-areas.py <dir> --json
    python3 scripts/class-areas.py https://storage.googleapis.com/bucket/a.tif --json

Areas are computed on the ellipsoid rather than by counting pixels and
multiplying by a nominal 10 by 10 metres. An Earth Engine export in EPSG:4326
has square degree pixels, not square metre pixels, so a pixel at 49 N covers
about two thirds the ground area of one at the equator. Counting them as equal
would overstate the northern half of a north-south project.
"""

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import numpy as np
    import rasterio
except ImportError as error:  # pragma: no cover
    sys.exit(f"{error}. Install with: sudo port install py312-rasterio")

# WGS84 authalic radius, the sphere with the same surface area as the
# ellipsoid. Using the equatorial radius instead would overstate areas by
# roughly 0.2 percent.
AUTHALIC_RADIUS_M = 6371007.181

CLASS_LABELS = {1: "Low", 2: "Moderate", 3: "High"}
DELTAS = ("dNDVI", "dNDMI", "dNBR")


def row_areas_m2(dataset):
    """Ground area of one pixel in each raster row, as a 1-D array."""
    transform = dataset.transform
    if dataset.crs and dataset.crs.is_projected:
        # A projected grid already has metre pixels, constant across the file.
        pixel = abs(transform.a * transform.e - transform.b * transform.d)
        return np.full(dataset.height, pixel, dtype="float64")

    # Geographic grid. Integrate the spherical zone between each row's top and
    # bottom latitude: A = R^2 * dlon * (sin(lat_top) - sin(lat_bottom)).
    dlon = math.radians(abs(transform.a))
    top = transform.f
    dlat = transform.e  # negative for a north-up raster
    edges = np.radians(top + dlat * np.arange(dataset.height + 1))
    return (AUTHALIC_RADIUS_M ** 2) * dlon * np.abs(np.diff(np.sin(edges)))


def areas_for(path):
    """Hectares in severity classes 1, 2 and 3, plus anything unexpected."""
    with rasterio.open(path) as dataset:
        if dataset.count != 1:
            raise SystemExit(f"{name_of(path)} has {dataset.count} bands, expected 1.")
        per_row = row_areas_m2(dataset)
        totals = {1: 0.0, 2: 0.0, 3: 0.0}
        unexpected = {}

        for _, window in dataset.block_windows(1):
            block = dataset.read(1, window=window, masked=True)
            rows = slice(window.row_off, window.row_off + window.height)
            weights = per_row[rows][:, None]
            values = np.unique(block.compressed())
            for value in values:
                if value == 0:
                    continue
                area = float(((block == value).filled(False) * weights).sum())
                if value in totals:
                    totals[int(value)] += area
                else:
                    unexpected[int(value)] = unexpected.get(int(value), 0.0) + area

    return (
        [round(totals[k] / 10_000.0, 1) for k in (1, 2, 3)],
        {k: round(v / 10_000.0, 1) for k, v in unexpected.items()},
    )


def is_url(source):
    return str(source).startswith(("http://", "https://", "/vsi"))


def name_of(source):
    """Last path segment, for a local path or a URL alike."""
    return str(source).rstrip("/").rsplit("/", 1)[-1].split("?")[0]


def expand(sources):
    """Directories become the GeoTIFFs inside them; everything else passes."""
    expanded = []
    for source in sources:
        if is_url(source):
            expanded.append(source)
            continue
        path = Path(source)
        if path.is_dir():
            expanded.extend(sorted(
                p for p in path.iterdir()
                if p.suffix.lower() in {".tif", ".tiff"}
            ))
        elif path.exists():
            expanded.append(path)
        else:
            sys.exit(f"No such file or directory: {source}")
    return expanded


def delta_of(name):
    upper = name.upper()
    for delta in DELTAS:
        if delta.upper() in upper:
            return delta
    if "NDBR" in upper:  # the older misspelling, seen in earlier exports
        return "dNBR"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+",
                        help="a directory, GeoTIFF paths, or https URLs")
    parser.add_argument("--json", action="store_true",
                        help="print an areasHa object ready to paste into the config")
    args = parser.parse_args()

    rasters = expand(args.sources)
    if not rasters:
        sys.exit("No GeoTIFFs found in the given sources.")

    measured = {}
    for path in rasters:
        name = name_of(path)
        delta = delta_of(name)
        if delta is None:
            print(f"{name}: not a disturbance layer, skipped", file=sys.stderr)
            continue
        areas, unexpected = areas_for(path)
        measured[delta] = areas
        if not args.json:
            total = sum(areas)
            print(f"{name}  ({delta})")
            for value, hectares in zip((1, 2, 3), areas):
                print(f"    {CLASS_LABELS[value]:<9} {hectares:>12,.1f} ha")
            print(f"    {'Total':<9} {total:>12,.1f} ha")
            if unexpected:
                print(f"    WARNING: values outside 1-3 present: {unexpected}")
            print()

    if args.json:
        json.dump({"areasHa": measured}, sys.stdout, indent=2)
        sys.stdout.write("\n")
    elif not measured:
        sys.exit("No disturbance layers recognised.")


if __name__ == "__main__":
    main()
