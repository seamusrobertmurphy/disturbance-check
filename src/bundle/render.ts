import { fromUrl } from "geotiff";
import {
  CLASS_PALETTES,
  type DeliveredLayer,
} from "./manifest";

// Drawing a delivered raster.
//
// The layers arrive as cloud-optimised GeoTIFFs carrying class numbers, not
// colours, which is deliberate. A picture can only be looked at; a raster can
// be queried, so the viewer can report the class under the cursor and total
// hectares inside a boundary the client uploads afterwards.
//
// Reading is cheap because the conversion wrote overviews: asking for a
// screen-sized array makes geotiff.js fetch the pyramid level that matches,
// not the full-resolution pixels.

/** Longest edge the browser is asked to hold, in pixels. */
const MAX_DIMENSION = 2048;

export interface RasterLayer {
  layer: DeliveredLayer;
  width: number;
  height: number;
  /** Class per pixel: 0 undisturbed or nodata, 1 Low, 2 Moderate, 3 High. */
  classes: Uint8Array;
  /** Lon/lat bounds, [west, south, east, north]. */
  bounds: [number, number, number, number];
  /** Corners for a MapLibre image source, clockwise from top left. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /** Metres per pixel of the delivered raster, before any downsampling. */
  nativeScale: number;
  /** True when the view is a reduced-resolution copy rather than every pixel. */
  downsampled: boolean;
}

/**
 * Read a delivered layer.
 *
 * The Earth Engine exports are written in EPSG:4326, so the bounding box is
 * already lon/lat and no reprojection is needed to place the image on the map.
 * That is checked rather than assumed: a raster in a projected CRS would land
 * in the wrong place, and silently.
 */
export async function readLayer(
  url: string,
  layer: DeliveredLayer,
  signal?: AbortSignal,
): Promise<RasterLayer> {
  const tiff = await fromUrl(url, {}, signal);
  const image = await tiff.getImage();

  const [west, south, east, north] = image.getBoundingBox() as [
    number,
    number,
    number,
    number,
  ];
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(north) > 90 ||
    Math.abs(south) > 90
  ) {
    throw new Error(
      `${layer.id} is not in geographic coordinates. Its bounds read ${[west, south, east, north].join(", ")}, which is a projected CRS. Re-export it in EPSG:4326, which is what the Earth Engine scripts write.`,
    );
  }

  const fullWidth = image.getWidth();
  const fullHeight = image.getHeight();
  const scale = Math.min(1, MAX_DIMENSION / Math.max(fullWidth, fullHeight));
  const width = Math.max(1, Math.round(fullWidth * scale));
  const height = Math.max(1, Math.round(fullHeight * scale));

  const result = await tiff.readRasters({
    width,
    height,
    interleave: false,
    // Nearest, always. These are class numbers: averaging class 1 with class 3
    // would produce a class 2 the analysis never found, and it would look like
    // a smoother, more precise map rather than an invented one.
    resampleMethod: "nearest",
    fillValue: 0,
    signal,
  });

  const band = (result as unknown as ArrayLike<ArrayLike<number>>)[0];
  const classes = new Uint8Array(width * height);
  for (let i = 0; i < classes.length; i += 1) {
    const value = band[i] ?? 0;
    classes[i] = value >= 1 && value <= 3 ? value : 0;
  }

  // Metres per pixel at the raster's own resolution, from the latitude of its
  // centre. Reported so a client can see the delivered scale rather than infer
  // it from how the map looks.
  const centreLat = (north + south) / 2;
  const metresPerDegree = 111320 * Math.cos((centreLat * Math.PI) / 180);
  const nativeScale =
    Math.round(((east - west) / fullWidth) * metresPerDegree * 10) / 10;

  return {
    layer,
    width,
    height,
    classes,
    bounds: [west, south, east, north],
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    nativeScale,
    downsampled: scale < 1,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Paint a class raster to a data URL.
 *
 * Class 0 is painted fully transparent, so the basemap and any layer beneath
 * shows through wherever nothing was detected. That is what lets a client see
 * that an absence of colour is an absence of change rather than an absence of
 * data.
 */
export function paint(raster: RasterLayer): string {
  const stops = CLASS_PALETTES[raster.layer.id].map(hexToRgb);
  const data = new Uint8ClampedArray(raster.width * raster.height * 4);

  for (let i = 0; i < raster.classes.length; i += 1) {
    const value = raster.classes[i];
    if (value === 0) continue;
    const [r, g, b] = stops[Math.min(stops.length - 1, value - 1)];
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }

  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser refused a 2D canvas context.");
  context.putImageData(new ImageData(data, raster.width, raster.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/** Pixel counts per class, from the raster actually on screen. */
export function countClasses(raster: RasterLayer): [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  for (const value of raster.classes) {
    if (value >= 1 && value <= 3) counts[value - 1] += 1;
  }
  return counts;
}

/**
 * The class at a lon/lat, or null outside the raster.
 *
 * Reads the array already in memory rather than the file, so it costs nothing
 * and works offline once a layer is drawn.
 */
export function classAt(
  raster: RasterLayer,
  lon: number,
  lat: number,
): number | null {
  const [west, south, east, north] = raster.bounds;
  if (lon < west || lon > east || lat < south || lat > north) return null;
  const x = Math.floor(((lon - west) / (east - west)) * raster.width);
  const y = Math.floor(((north - lat) / (north - south)) * raster.height);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  return raster.classes[y * raster.width + x];
}
