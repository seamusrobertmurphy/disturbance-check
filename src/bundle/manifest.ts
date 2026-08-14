// The delivered bundle.
//
// This app does not compute anything. The disturbance layers were produced by
// the Earth Engine scripts run in QGIS or ArcGIS, exported as GeoTIFFs, and
// converted to cloud-optimised GeoTIFFs by scripts/prepare-bundle.mjs. What
// ships is those rasters plus this manifest describing them.
//
// The manifest is the deliverable's provenance, not decoration. A client
// looking at a red polygon is entitled to know which windows were differenced,
// which thresholds were applied, whether any of them deviated from the SOP
// default and why, and how many hectares fell in each class. All of that has
// to travel with the raster or the raster is just a picture.

export const MANIFEST_PATH = "bundle/manifest.json";

export type DeltaId = "dNDVI" | "dNDMI" | "dNBR";

export interface Breaks {
  low: number;
  moderate: number;
  high: number;
}

export interface DeliveredLayer {
  id: DeltaId;
  /** Shown in the Layer panel. */
  label: string;
  /** Path to the cloud-optimised GeoTIFF, relative to the manifest. */
  cog: string;
  /** Thresholds actually applied, which may deviate from the SOP default. */
  breaks: Breaks;
  /** Hectares per class, index 0 Low, 1 Moderate, 2 High. */
  areasHa: [number, number, number];
  /**
   * Why the thresholds deviated, where they did.
   *
   * Null when the SOP defaults were used. Non-null and empty is a defect: SOP
   * Step 6 requires a written justification for any deviation, and the panel
   * says so rather than passing it off as documented.
   */
  justification: string | null;
}

export interface DeliveredPeriod {
  /** RP1, RP2 and so on. */
  id: string;
  preStart: string;
  preEnd: string;
  postStart: string;
  postEnd: string;
  layers: DeliveredLayer[];
}

export interface Provenance {
  /** Which script produced these layers, and its version or date. */
  script: string;
  /** Earth Engine collection the composites were built from. */
  collection: string;
  /** How cloud was removed, in the words of the script that did it. */
  cloudRemoval: string;
  /** Pixel size of the delivered rasters, in metres. */
  scale: number;
  /** When the analysis was run, ISO date. */
  runDate: string;
  /** Who ran it. */
  analyst: string;
}

export interface Bundle {
  /** Format version, so an older app refuses a newer bundle rather than
   * misreading it. */
  version: 1;
  project: string;
  client: string;
  /** The project boundary the analysis was clipped to, as GeoJSON. Drawn on
   * open so a client always sees the extent the numbers describe. */
  boundary: unknown | null;
  boundaryAreaHa: number | null;
  periods: DeliveredPeriod[];
  provenance: Provenance;
  /** Warnings the run raised, carried through verbatim. */
  warnings: string[];
}

/** SOP Step 6 defaults, for spotting a deviation the manifest failed to
 * declare. */
export const SOP_DEFAULT_BREAKS: Record<DeltaId, Breaks> = {
  dNDVI: { low: 0.1, moderate: 0.2, high: 0.35 },
  dNDMI: { low: 0.15, moderate: 0.3, high: 0.45 },
  dNBR: { low: 0.1, moderate: 0.27, high: 0.44 },
};

export const CLASS_LABELS = ["Low", "Moderate", "High"];

/** Palettes lifted from the production scripts, so a layer here looks like the
 * same layer in QGIS. */
export const CLASS_PALETTES: Record<DeltaId, string[]> = {
  dNDVI: ["#FFEDA0", "#FC4E2A", "#800026"],
  dNDMI: ["#FEB24C", "#FD8D3C", "#B10026"],
  dNBR: ["#FFEDA0", "#FC4E2A", "#800026"],
};

export function breaksDeviate(layer: DeliveredLayer): boolean {
  const defaults = SOP_DEFAULT_BREAKS[layer.id];
  return (
    layer.breaks.low !== defaults.low ||
    layer.breaks.moderate !== defaults.moderate ||
    layer.breaks.high !== defaults.high
  );
}

/**
 * Read and check the bundle.
 *
 * Refuses rather than guesses. A client viewing the wrong layers, or layers
 * whose thresholds are not the ones the manifest claims, is worse than a
 * client seeing an error, because nothing on screen would look wrong.
 */
export async function loadBundle(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Bundle> {
  const url = new URL(MANIFEST_PATH, baseUrl).href;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `No delivered bundle at ${url} (${response.status}). This build carries no disturbance layers.`,
    );
  }

  const bundle = (await response.json()) as Bundle;
  if (bundle.version !== 1) {
    throw new Error(
      `The bundle declares format version ${bundle.version}, which this viewer does not read.`,
    );
  }
  if (!bundle.periods?.length) {
    throw new Error("The bundle contains no reporting periods.");
  }
  for (const period of bundle.periods) {
    for (const layer of period.layers) {
      if (!layer.cog) {
        throw new Error(
          `${period.id} ${layer.id} names no raster, so it cannot be shown.`,
        );
      }
    }
  }
  return bundle;
}

/** Absolute URL of a layer's raster. */
export function cogUrl(baseUrl: string, layer: DeliveredLayer): string {
  return new URL(layer.cog, new URL(MANIFEST_PATH, baseUrl)).href;
}

/** Total hectares flagged across the three classes. */
export function totalFlaggedHa(layer: DeliveredLayer): number {
  return layer.areasHa[0] + layer.areasHa[1] + layer.areasHa[2];
}
