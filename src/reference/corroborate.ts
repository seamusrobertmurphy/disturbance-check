import {
  queryGeoJson,
  queryStats,
  serviceLayers,
  type ServiceLayer,
} from "./arcgis";
import {
  canadianFires,
  interagencyFires,
  withinCanada,
  type FireRecord,
} from "./fire";
import { managementActivity, type ManagementSummary } from "./management";

// Independent records of what happened on the ground.
//
// The index maths says a delta moved. It cannot say why, and a verifier is not
// entitled to assume. This module gathers the registries that answer the why:
// an aerial observer's record of insect and disease damage, and mapped fire
// from three registries with different lags and different borders.
//
// They corroborate; they are never inputs. Nothing here touches a composite, a
// delta, a break or an area. A finding that cites them cites them as separate
// evidence with its own provenance and its own date, which is the whole point
// of triangulating.
//
// Coverage is reported rather than left to be discovered. An empty result from
// a survey that never flew reads exactly like an empty result from a forest
// that was never damaged, and the two mean opposite things. The insect survey
// is United States only; fire is covered in both the United States and Canada
// by different registries.

const FS_ARCGIS = "https://apps.fs.usda.gov/arcx/rest/services/EDW";

export const IDS_SERVICE = `${FS_ARCGIS}/EDW_InsectandDiseaseSurvey_01/MapServer`;
export const MTBS_SERVICE = `${FS_ARCGIS}/EDW_MTBS_01/MapServer`;

/** IDS AREAS. Layer 0 is the point survey, which is coarser and not used. */
export const IDS_AREAS_LAYER = 1;

export const IDS_ATTRIBUTION =
  "USDA Forest Service, Forest Health Protection, Insect and Disease Survey";
export const MTBS_ATTRIBUTION =
  "Monitoring Trends in Burn Severity, USGS and USDA Forest Service";

/**
 * Rough extent of the surveys, lon/lat.
 *
 * Deliberately generous: the question this answers is "could this dataset
 * plausibly cover the site", not "does it". A false positive costs one empty
 * query; a false negative would hide real corroborating evidence.
 */
const US_EXTENT: Array<[number, number, number, number]> = [
  [-125.1, 24.4, -66.9, 49.4], // Conterminous states
  [-179.2, 51.2, -129.9, 71.5], // Alaska
  [-160.3, 18.9, -154.8, 22.3], // Hawaii
  [-67.3, 17.9, -64.5, 18.6], // Puerto Rico and the Virgin Islands
];

export function withinUnitedStates(
  bbox: [number, number, number, number],
): boolean {
  const [west, south, east, north] = bbox;
  return US_EXTENT.some(
    ([w, s, e, n]) => west < e && east > w && south < n && north > s,
  );
}

export interface DamageGroup {
  year: number;
  /** Mortality, Defoliation, and so on. */
  damageType: string;
  /** The agent an observer recorded, e.g. "Douglas-fir beetle". */
  agent: string;
  acres: number;
  records: number;
}

export interface IdsSummary {
  covered: boolean;
  groups: DamageGroup[];
  totalAcres: number;
}

/**
 * Insect and disease damage recorded over the area, by year and agent.
 *
 * The years queried are the reporting windows themselves. A defoliation
 * mapped in the post window and absent from the pre window is the single most
 * useful thing a verifier can learn about a dNDMI signal, because it converts
 * "the moisture index dropped" into "an observer flew over and recorded fir
 * engraver mortality across four hundred acres".
 *
 * Acres come from the survey's own field rather than from the geometry. The
 * polygons are sketch-mapped from an aircraft and their areas are approximate
 * by construction, so recomputing them would imply a precision the source does
 * not have.
 */
export async function insectAndDisease(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<IdsSummary> {
  if (!withinUnitedStates(bbox)) {
    return { covered: false, groups: [], totalAcres: 0 };
  }
  if (years.length === 0) return { covered: true, groups: [], totalAcres: 0 };

  const rows = await queryStats(`${IDS_SERVICE}/${IDS_AREAS_LAYER}`, {
    where: `survey_year >= ${Math.min(...years)} AND survey_year <= ${Math.max(...years)}`,
    bbox,
    groupBy: ["survey_year", "damage_type", "dca_common_name"],
    statistics: [
      {
        statisticType: "sum",
        onStatisticField: "acres",
        outStatisticFieldName: "total_acres",
      },
      {
        statisticType: "count",
        onStatisticField: "objectid",
        outStatisticFieldName: "records",
      },
    ],
    signal,
  });

  const groups: DamageGroup[] = rows
    .map((row) => ({
      year: Number(row.survey_year ?? 0),
      damageType: String(row.damage_type ?? "unrecorded"),
      agent: String(row.dca_common_name ?? "unknown"),
      acres: Number(row.total_acres ?? 0),
      records: Number(row.records ?? 0),
    }))
    .filter((group) => group.acres > 0)
    .sort((a, b) => b.acres - a.acres);

  return {
    covered: true,
    groups,
    totalAcres: groups.reduce((total, group) => total + group.acres, 0),
  };
}

export interface Fire {
  name: string;
  year: number;
  acres: number;
  /** Ignition date, ISO, where the source recorded one. */
  ignition: string | null;
}

export interface MtbsSummary {
  covered: boolean;
  fires: Fire[];
  /** Burned area boundaries as GeoJSON, for drawing. */
  perimeters: { type: "FeatureCollection"; features: unknown[] };
  /** Years actually queried, so the panel can say what was and was not looked at. */
  yearsSearched: number[];
  /** Years requested that the service does not publish. */
  yearsUnavailable: number[];
}

const YEAR_LAYER = /^(\d{4})\s+Burned Area Boundaries$/;

/** Map each published year to its layer id, read from the service itself
 * rather than assumed, because the numbering shifts as years are added. */
async function burnedAreaLayers(
  signal?: AbortSignal,
): Promise<Map<number, ServiceLayer>> {
  const layers = await serviceLayers(MTBS_SERVICE, signal);
  const byYear = new Map<number, ServiceLayer>();
  for (const layer of layers) {
    const match = YEAR_LAYER.exec(layer.name.trim());
    if (match) byYear.set(Number(match[1]), layer);
  }
  return byYear;
}

/**
 * Fires that burned into the area during the reporting windows.
 *
 * MTBS assesses severity from imagery a year or more after the fire, so the
 * most recent season is routinely absent. That gap is reported as
 * `yearsUnavailable` rather than passed off as an absence of fire, which it is
 * not.
 */
export async function burnedAreas(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<MtbsSummary> {
  const empty = {
    type: "FeatureCollection" as const,
    features: [] as unknown[],
  };
  if (!withinUnitedStates(bbox)) {
    return {
      covered: false,
      fires: [],
      perimeters: empty,
      yearsSearched: [],
      yearsUnavailable: [],
    };
  }

  const byYear = await burnedAreaLayers(signal);
  const searched: number[] = [];
  const unavailable: number[] = [];
  const fires: Fire[] = [];
  const features: unknown[] = [];

  for (const year of years) {
    const layer = byYear.get(year);
    if (!layer) {
      unavailable.push(year);
      continue;
    }
    searched.push(year);
    const collection = await queryGeoJson(`${MTBS_SERVICE}/${layer.id}`, {
      bbox,
      outFields: ["fire_name", "year", "acres", "ig_date"],
      // Perimeters are drawn for orientation, not measured, so a metre of
      // generalisation is free and keeps a large fire cheap to render.
      simplify: 0.0002,
      signal,
    });
    for (const feature of collection.features) {
      const properties =
        (feature as { properties?: Record<string, unknown> }).properties ?? {};
      fires.push({
        name: String(properties.fire_name ?? "unnamed"),
        year: Number(properties.year ?? year),
        acres: Number(properties.acres ?? 0),
        ignition: parseIgnition(properties.ig_date),
      });
      features.push(feature);
    }
  }

  fires.sort((a, b) => b.acres - a.acres);
  return {
    covered: true,
    fires,
    perimeters: { type: "FeatureCollection", features },
    yearsSearched: searched,
    yearsUnavailable: unavailable,
  };
}

/** `20200817` or an epoch in milliseconds, both of which this service uses
 * depending on the response format, to `2020-08-17`. */
function parseIgnition(value: unknown): string | null {
  if (typeof value === "number" && value > 10_000_000_000) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const text = String(value ?? "");
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

/** Every calendar year a set of reporting windows touches. */
export function yearsCovered(
  periods: Array<{ preStart: string; preEnd: string; postStart: string; postEnd: string }>,
): number[] {
  const years = new Set<number>();
  for (const period of periods) {
    for (const date of [period.preStart, period.preEnd, period.postStart, period.postEnd]) {
      const year = Number(date.slice(0, 4));
      if (Number.isFinite(year) && year > 1900) years.add(year);
    }
    // Everything between the two windows counts. A fire in 2021 is the
    // explanation for a 2019 against 2023 delta even though neither window
    // contains it, and omitting the intervening years would hide it.
    const first = Number(period.preStart.slice(0, 4));
    const last = Number(period.postEnd.slice(0, 4));
    if (Number.isFinite(first) && Number.isFinite(last)) {
      for (let year = first; year <= last; year += 1) years.add(year);
    }
  }
  return [...years].sort((a, b) => a - b);
}


// ---------------------------------------------------------------------------
// Orchestration

export interface Coverage {
  unitedStates: boolean;
  canada: boolean;
  /** True when no registry in this tool covers the area at all. */
  none: boolean;
}

export function coverageFor(bbox: [number, number, number, number]): Coverage {
  const unitedStates = withinUnitedStates(bbox);
  const canada = withinCanada(bbox);
  return { unitedStates, canada, none: !unitedStates && !canada };
}

export interface FireEvidence {
  records: FireRecord[];
  perimeters: { type: "FeatureCollection"; features: unknown[] };
  /** Years MTBS has not yet assessed, so absence proves nothing. */
  yearsUnassessed: number[];
  sources: string[];
}

/**
 * Every fire registry that covers the area, gathered together.
 *
 * Run concurrently and failure-tolerant per source. One registry being down is
 * a reason to report that registry as unavailable, not to lose the evidence
 * from the other two, and a verifier needs to know which of the three answered
 * before drawing a conclusion from silence.
 */
export async function fireEvidence(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<FireEvidence> {
  const coverage = coverageFor(bbox);
  const records: FireRecord[] = [];
  const features: unknown[] = [];
  const sources: string[] = [];
  let yearsUnassessed: number[] = [];

  const jobs: Array<Promise<void>> = [];

  if (coverage.unitedStates) {
    jobs.push(
      burnedAreas(bbox, years, signal)
        .then((summary) => {
          for (const fire of summary.fires) {
            records.push({
              source: "MTBS",
              name: fire.name,
              year: fire.year,
              hectares: fire.acres * 0.404686,
              started: fire.ignition,
              ended: null,
              cause: null,
            });
          }
          features.push(...summary.perimeters.features);
          yearsUnassessed = summary.yearsUnavailable;
          sources.push("MTBS");
        })
        .catch(() => {}),
    );
    jobs.push(
      interagencyFires(bbox, years, signal)
        .then((found) => {
          records.push(...found);
          sources.push("NIFC");
        })
        .catch(() => {}),
    );
  }

  if (coverage.canada) {
    jobs.push(
      canadianFires(bbox, years, signal)
        .then((found) => {
          records.push(...found.records);
          features.push(...found.perimeters);
          sources.push("NBAC");
        })
        .catch(() => {}),
    );
  }

  await Promise.all(jobs);

  records.sort((a, b) => b.hectares - a.hectares);
  return {
    records,
    perimeters: { type: "FeatureCollection", features },
    yearsUnassessed,
    sources,
  };
}


/**
 * Recorded management over the area, where the jurisdiction publishes it.
 *
 * Only National Forest System land is covered, so this is attempted only
 * inside the United States and its absence is reported by the caller as a
 * question of jurisdiction rather than of harvest.
 */
export async function managementRecord(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<ManagementSummary | null> {
  if (!withinUnitedStates(bbox)) return null;
  try {
    return await managementActivity(bbox, years, signal);
  } catch {
    return null;
  }
}
