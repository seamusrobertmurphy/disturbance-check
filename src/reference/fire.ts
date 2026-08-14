import { queryGeoJson, queryStats } from "./arcgis";

// Mapped fire, from three registries with different jobs.
//
// No single source answers "did this burn". MTBS assesses severity from
// imagery a year or more after the event, so it is authoritative and always
// late. The interagency perimeter feed is same-season and therefore covers the
// years MTBS has not reached, at the cost of being an operational product
// rather than an assessment. Both stop at the border, so Canadian projects
// need the National Burned Area Composite, which is the Canadian Forest
// Service equivalent and runs from 1972.
//
// A verifier should see all three and see which one each record came from,
// because they disagree in instructive ways. Over the 2020 Oregon fires the
// interagency feed and MTBS differ by a few hundred acres on perimeters close
// to two hundred thousand, which is the ordinary disagreement between an
// operational perimeter and a severity assessment, and is itself worth knowing
// before quoting either to four significant figures.

export type FireSource = "MTBS" | "NIFC" | "NBAC";

export interface FireRecord {
  source: FireSource;
  name: string;
  year: number;
  hectares: number;
  /** Discovery or ignition date where the registry records one, ISO. */
  started: string | null;
  /** Containment or final mapping date, ISO. */
  ended: string | null;
  cause: string | null;
}

const ACRES_TO_HECTARES = 0.404686;

// ---------------------------------------------------------------------------
// United States, current season and recent years

const NIFC_PERIMETERS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0";

export const NIFC_ATTRIBUTION =
  "Wildland Fire Interagency Geospatial Services, National Interagency Fire Center";

function epochToIso(value: unknown): string | null {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * Interagency perimeters intersecting the area.
 *
 * Filtered by year here rather than in the query, because the feed's date
 * fields are epochs and a server-side range on them is fragile across service
 * revisions. The result set over one project boundary is small enough that
 * filtering locally costs nothing.
 */
export async function interagencyFires(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<FireRecord[]> {
  const collection = await queryGeoJson(NIFC_PERIMETERS, {
    bbox,
    outFields: [
      "poly_IncidentName",
      "attr_FireDiscoveryDateTime",
      "attr_ContainmentDateTime",
      "poly_GISAcres",
      "attr_FireCause",
    ],
    simplify: 0.0002,
    limit: 200,
    signal,
  });

  const wanted = new Set(years);
  const records: FireRecord[] = [];
  for (const feature of collection.features) {
    const properties =
      (feature as { properties?: Record<string, unknown> }).properties ?? {};
    const started = epochToIso(properties.attr_FireDiscoveryDateTime);
    const year = started ? Number(started.slice(0, 4)) : Number.NaN;
    if (!Number.isFinite(year) || !wanted.has(year)) continue;
    const acres = Number(properties.poly_GISAcres ?? 0);
    records.push({
      source: "NIFC",
      name: String(properties.poly_IncidentName ?? "unnamed"),
      year,
      hectares: acres * ACRES_TO_HECTARES,
      started,
      ended: epochToIso(properties.attr_ContainmentDateTime),
      cause: (properties.attr_FireCause as string) ?? null,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Canada, 1972 onwards

const CWFIS_WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows";

export const NBAC_ATTRIBUTION =
  "National Burned Area Composite, Canadian Forest Service, Natural Resources Canada";

/** Rough Canadian extent, lon/lat. */
export function withinCanada(bbox: [number, number, number, number]): boolean {
  const [west, south, east, north] = bbox;
  return west < -52.6 && east > -141.1 && south < 83.2 && north > 41.6;
}

/**
 * Canadian burned area over the AOI.
 *
 * The axis order here is the trap. WFS 2.0 addressed with the URN form of
 * EPSG:4326 uses the authority's own axis order, which for that code is
 * latitude then longitude. Passing a lon/lat bbox returns an empty collection
 * with a 200, which looks exactly like an area that never burned.
 */
export async function canadianFires(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<{ records: FireRecord[]; perimeters: unknown[] }> {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "public:nbac",
    bbox: `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`,
    outputFormat: "application/json",
    count: "200",
  });

  const response = await fetch(`${CWFIS_WFS}?${params}`, { signal });
  if (!response.ok) {
    throw new Error(
      `The Canadian burned area service returned ${response.status}.`,
    );
  }
  const payload = (await response.json()) as { features?: unknown[] };

  const wanted = new Set(years);
  const records: FireRecord[] = [];
  const perimeters: unknown[] = [];
  for (const feature of payload.features ?? []) {
    const properties =
      (feature as { properties?: Record<string, unknown> }).properties ?? {};
    const year = Number(properties.year ?? 0);
    if (!wanted.has(year)) continue;
    records.push({
      source: "NBAC",
      // The composite identifies fires by number, not name. Inventing a label
      // would read like a name the source does not have.
      name: `NBAC fire ${properties.nfireid ?? "unnumbered"}`,
      year,
      // adj_ha is the composite's own adjusted area and is the figure to
      // quote; poly_ha is the raw polygon area before adjustment.
      hectares: Number(properties.adj_ha ?? properties.poly_ha ?? 0),
      started: trimZ(properties.ag_sdate ?? properties.hs_sdate),
      ended: trimZ(properties.ag_edate ?? properties.hs_edate),
      cause: (properties.firecaus as string) ?? null,
    });
    perimeters.push(feature);
  }
  return { records, perimeters };
}

/** `2023-09-08Z` to `2023-09-08`. */
function trimZ(value: unknown): string | null {
  const text = String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Severity classes, for the areas MTBS has assessed

const MTBS_SERVICE =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer";

export interface SeverityBreakdown {
  fireName: string;
  year: number;
  /** Burned area boundaries carry an assessment type: initial or extended. */
  assessment: string | null;
}

/**
 * Assessment type per fire.
 *
 * An initial assessment maps the fire soon after containment and an extended
 * one waits a growing season, which matters when comparing against a delta
 * computed from late-summer imagery. Reported so a verifier can see which they
 * are quoting rather than treating the two as one product.
 */
export async function assessmentTypes(
  bbox: [number, number, number, number],
  layerId: number,
  signal?: AbortSignal,
): Promise<SeverityBreakdown[]> {
  const rows = await queryStats(`${MTBS_SERVICE}/${layerId}`, {
    bbox,
    groupBy: ["fire_name", "year", "asmnt_type"],
    statistics: [
      {
        statisticType: "count",
        onStatisticField: "objectid",
        outStatisticFieldName: "records",
      },
    ],
    signal,
  });
  return rows.map((row) => ({
    fireName: String(row.fire_name ?? "unnamed"),
    year: Number(row.year ?? 0),
    assessment: (row.asmnt_type as string) ?? null,
  }));
}
