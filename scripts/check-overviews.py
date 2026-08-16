#!/usr/bin/env python3
"""Decide whether a class raster's overviews were built by averaging.

Why this exists. The delivered layers carry severity class numbers, not
measurements. Averaging class 1 with class 3 produces class 2, a moderate
severity the analysis never found, and the result is invisible: the map looks
smoother and therefore more precise. scripts/prepare-bundle.mjs avoids this
locally by passing OVERVIEW_RESAMPLING=NEAREST to GDAL, but a cloud-optimised
GeoTIFF written by Earth Engine's own exporter carries overviews this repo did
not build and whose resampling the Earth Engine documentation does not state.
So it is measured rather than assumed.

The test. Checking which class values appear is useless, because an averaged
1 and 3 lands on 2 and 2 is a legal class. Instead each overview pixel is
compared against the full-resolution block beneath it, using the one property
that defines nearest neighbour:

    a nearest-neighbour overview pixel is always one of the values present in
    the block it came from, because it is a copy of one of them

So an overview pixel holding a value absent from its own block is proof that
something interpolated. This catches the case that matters, a 1 and a 3
averaging to a 2, which no test on the set of values present could catch,
because 2 is a legal class.

A narrower earlier version of this test looked only at blocks of 0 and 3 and
could never fire, because GDAL's average resampling honours the nodata value
and skips the zeros: a block of three 0s and a 3 averages to 3, not to 0.75.
The danger was never nodata bleeding into data. It is one real class bleeding
into another.

Usage:
    python3 scripts/check-overviews.py <geotiff or https URL> [...]
    python3 scripts/check-overviews.py <url> --json

Exit status is 1 if any raster fails, so this can gate a build.
"""

import argparse
import json
import sys

try:
    import numpy as np
    import rasterio
    from rasterio.windows import Window
except ImportError as error:  # pragma: no cover
    sys.exit(f"{error}. Install with: sudo port install py312-rasterio")

# How many overview blocks to inspect per raster. Every block would mean
# streaming the whole raster twice. This is a cap and it is reported, because a
# silent cap reads as "everything was checked" when it was not.
MAX_BLOCKS = 200
BLOCK = 256


def check(source):
    """Inspect one raster. Returns a result dict."""
    result = {
        "source": str(source),
        "overviews": [],
        "blocksExamined": 0,
        "blocksAvailable": 0,
        "violations": [],
        "verdict": "unknown",
    }

    with rasterio.open(source) as full:
        factors = full.overviews(1)
        result["overviews"] = factors
        if not factors:
            result["verdict"] = "no overviews"
            return result
        width, height = full.width, full.height

        # The factor-2 overview is where averaging is easiest to prove: its
        # blocks are 2x2, small enough that "only 0 and 3 present" is common.
        factor = factors[0]

        with rasterio.open(source, OVERVIEW_LEVEL=0) as over:
            cols = range(0, over.width, BLOCK)
            rows = range(0, over.height, BLOCK)
            windows = [(r, c) for r in rows for c in cols]
            result["blocksAvailable"] = len(windows)

            # Walk from the middle outwards. Disturbance tends to sit inland
            # rather than on the raster's nodata margin, so the middle blocks
            # are the ones carrying mixed content worth testing.
            windows.sort(key=lambda rc: abs(rc[0] - over.height / 2)
                         + abs(rc[1] - over.width / 2))

            for row_off, col_off in windows[:MAX_BLOCKS]:
                w = min(BLOCK, over.width - col_off)
                h = min(BLOCK, over.height - row_off)
                coarse = over.read(1, window=Window(col_off, row_off, w, h))

                fine = full.read(1, window=Window(
                    col_off * factor, row_off * factor,
                    min(w * factor, width - col_off * factor),
                    min(h * factor, height - row_off * factor),
                ))
                fh, fw = fine.shape
                usable_h, usable_w = fh // factor, fw // factor
                if usable_h == 0 or usable_w == 0:
                    continue

                # Reshape the full-resolution window into one group per
                # overview pixel, then ask what each group contains.
                blocks = (fine[:usable_h * factor, :usable_w * factor]
                          .reshape(usable_h, factor, usable_w, factor)
                          .transpose(0, 2, 1, 3)
                          .reshape(usable_h, usable_w, factor * factor))
                coarse = coarse[:usable_h, :usable_w]
                result["blocksExamined"] += 1

                # Under nearest the overview pixel is a copy of one of the
                # pixels beneath it, so it must appear in its own block.
                impossible = ~(blocks == coarse[:, :, None]).any(axis=2)

                if impossible.any():
                    ys, xs = np.nonzero(impossible)
                    for y, x in list(zip(ys, xs))[:5]:
                        result["violations"].append({
                            "overviewPixel": [int(col_off + x), int(row_off + y)],
                            "overviewValue": int(coarse[y, x]),
                            "blockValues": sorted(
                                int(v) for v in np.unique(blocks[y, x])
                            ),
                        })
                    if len(result["violations"]) >= 5:
                        break

    result["verdict"] = "averaged" if result["violations"] else "nearest"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", help="GeoTIFF paths or https URLs")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    results = [check(source) for source in args.sources]

    if args.json:
        json.dump(results, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        for result in results:
            name = result["source"].rstrip("/").rsplit("/", 1)[-1]
            print(f"{name}")
            print(f"    overviews        {result['overviews'] or 'none'}")
            print(f"    blocks examined  {result['blocksExamined']} "
                  f"of {result['blocksAvailable']}"
                  + (f" (capped at {MAX_BLOCKS})"
                     if result["blocksAvailable"] > MAX_BLOCKS else ""))
            print(f"    verdict          {result['verdict']}")
            for violation in result["violations"]:
                print(f"      overview pixel {violation['overviewPixel']} reads "
                      f"{violation['overviewValue']} above a block of "
                      f"{violation['blockValues']}")
            if result["verdict"] == "no overviews":
                print("      The viewer will fetch full resolution at every zoom.")
            elif result["verdict"] == "averaged":
                print("      These overviews invent severity classes. Do not ship them.")
            print()

    failed = [r for r in results if r["verdict"] != "nearest"]
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
