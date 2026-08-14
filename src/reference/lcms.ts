// LCMS, the Forest Service Landscape Change Monitoring System.
//
// An annual, wall-to-wall classification of change across the conterminous
// United States, derived from the full Landsat and Sentinel-2 record by a
// method entirely unlike this tool's. That independence is the value. When a
// dNDVI threshold flags a stand and LCMS labels the same year and the same
// ground as fast loss, two unrelated methods agree. When they disagree, the
// disagreement is the finding.
//
// It is a corroborating layer and never an input, for the same reason the fire
// and insect registries are: nothing in the SOP calculation may depend on
// another party's model.



const LCMS_BASE =
  "https://imagery.geoplatform.gov/iipp/rest/services/Vegetation";

export const LCMS_ATTRIBUTION =
  "Landscape Change Monitoring System, USDA Forest Service";

export interface LcmsProduct {
  id: string;
  label: string;
  description: string;
  service: string;
}

export const LCMS_PRODUCTS: LcmsProduct[] = [
  {
    id: "change",
    label: "Annual change",
    description:
      "The change class assigned to each pixel for the selected year: stable, slow loss, fast loss or gain.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_AnnualChange_CONUS/ImageServer`,
  },
  {
    id: "fast-loss",
    label: "Year of highest fast loss",
    description:
      "The year each pixel was most likely to have undergone abrupt loss, the signature of harvest, fire and blowdown.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_YearHighestProbabilityFastLoss_CONUS/ImageServer`,
  },
  {
    id: "slow-loss",
    label: "Year of highest slow loss",
    description:
      "The year each pixel was most likely to have undergone gradual loss, the signature of insect and disease mortality and drought.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_YearHighestProbabilitySlowLoss_CONUS/ImageServer`,
  },
];

/**
 * Midpoint of a calendar year, in epoch milliseconds.
 *
 * The service is a time-enabled mosaic rather than a multidimensional raster,
 * so a year is selected by asking for an instant inside it. Midyear rather
 * than the first of January, which sits on the boundary between two annual
 * rasters and can return whichever the service orders first.
 */
export function yearInstant(year: number): number {
  return Date.UTC(year, 6, 1);
}

export interface LcmsRequest {
  product: LcmsProduct;
  year: number;
  /** Lon/lat bounds of the delivered raster, [west, south, east, north]. */
  bbox: [number, number, number, number];
  size?: number;
  signal?: AbortSignal;
}

export interface LcmsOverlay {
  /** Object URL for the exported PNG. */
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  release: () => void;
}

/**
 * Export the product over the working grid as a drawable overlay.
 *
 * The image is requested in the grid's own UTM zone rather than Web Mercator,
 * so it lands on the same footprint as the analysis and can be compared pixel
 * for pixel by eye. Asking for Mercator would introduce a rotation against
 * every other layer on the map.
 */
export async function exportOverlay(
  request: LcmsRequest,
): Promise<LcmsOverlay> {
  const [west, south, east, north] = request.bbox;
  const width = Math.min(2048, request.size ?? 1024);
  const height = Math.max(
    1,
    Math.round(width * ((north - south) / (east - west))),
  );

  // Requested in geographic coordinates, matching the delivered rasters, which
  // the Earth Engine scripts export in EPSG:4326. Asking for anything else
  // would rotate this overlay against the layers it exists to be compared with.
  const params = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    bboxSR: "4326",
    imageSR: "4326",
    size: `${width},${height}`,
    format: "png32",
    time: String(yearInstant(request.year)),
    f: "image",
  });

  const response = await fetch(
    `${request.product.service}/exportImage?${params}`,
    { signal: request.signal },
  );
  if (!response.ok) {
    throw new Error(
      `${request.product.label} returned ${response.status}. The overlay is unavailable; the delivered layers are unaffected.`,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  return {
    url,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    release: () => URL.revokeObjectURL(url),
  };
}

export interface LegendEntry {
  label: string;
  /** Data URL of the swatch the service publishes. */
  swatch: string;
}

/** The service's own legend, so classes are named as it names them rather
 * than as this tool guesses. */
export async function legend(
  product: LcmsProduct,
  signal?: AbortSignal,
): Promise<LegendEntry[]> {
  const response = await fetch(`${product.service}/legend?f=json`, { signal });
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    layers?: Array<{
      legend?: Array<{ label?: string; imageData?: string; contentType?: string }>;
    }>;
  };
  const entries = payload.layers?.[0]?.legend ?? [];
  return entries
    .filter((entry) => entry.label && entry.imageData)
    .map((entry) => ({
      label: String(entry.label),
      swatch: `data:${entry.contentType ?? "image/png"};base64,${entry.imageData}`,
    }));
}

/** LCMS covers the conterminous states, Alaska, Hawaii and Puerto Rico as
 * separate products. Only the CONUS services are wired up here. */
export function withinConus(bbox: [number, number, number, number]): boolean {
  const [west, south, east, north] = bbox;
  return west < -66.9 && east > -125.1 && south < 49.4 && north > 24.4;
}
