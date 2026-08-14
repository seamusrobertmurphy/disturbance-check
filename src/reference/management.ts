import { queryGeoJson, queryStats } from "./arcgis";

// The management record.
//
// Every other corroborating dataset in this tool is a measurement of the
// canopy: something looked at the forest and reported that it changed. This
// one is different in kind. It is the record of what was *done*, entered by
// the people who did it, with a date and an acreage.
//
// For IFM verification that distinction is the whole question. A dNDVI signal
// over a stand that FACTS records as a clearcut completed in the post window
// is a reported harvest behaving exactly as it should. The same signal over a
// stand with no activity record is the finding.
//
// National Forest System land only. Private and state ownership, which is most
// of the IFM estate, is not in FACTS, so an absence here is very often an
// absence of jurisdiction rather than an absence of harvest. The panel says so.

const FACTS_SERVICE =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ActivityFactsCommonAttributes_01/MapServer/0";

export const FACTS_ATTRIBUTION =
  "USDA Forest Service Activity Tracking System (FACTS), common attributes";

/**
 * Activity classes that remove or reduce canopy.
 *
 * Deliberately not every activity. FACTS records surveys, examinations,
 * certifications and prescriptions alongside the treatments themselves, and a
 * "Silvicultural Stand Examination" is somebody walking through the stand with
 * a clipboard. Including those would bury the two or three records that
 * actually explain a delta under a hundred that cannot.
 */
const CANOPY_ACTIVITIES = [
  "Clearcut",
  "Seed Tree",
  "Shelterwood",
  "Overstory Removal",
  "Commercial Thin",
  "Precommercial Thin",
  "Salvage",
  "Sanitation",
  "Group Selection",
  "Single-tree Selection",
  "Patch Clearcut",
  "Improvement Cut",
  "Liberation Cut",
  "Thinning",
  "Mastication",
  "Broadcast Burning",
  "Piling",
  "Yarding",
];

/** A LIKE clause covering the canopy-affecting activities. */
function activityFilter(): string {
  return CANOPY_ACTIVITIES.map(
    (term) => `activity LIKE '%${term.replace(/'/g, "''")}%'`,
  ).join(" OR ");
}

export interface Activity {
  activity: string;
  /** Completion date, ISO, where one was entered. */
  completed: string | null;
  acres: number;
  method: string | null;
}

export interface ManagementSummary {
  /** True when the query ran; false when the area is outside the surveyed
   * extent and nothing was asked. */
  queried: boolean;
  activities: Activity[];
  /** Total acreage of canopy-affecting activity inside the years asked for. */
  totalAcres: number;
  /** Records whose completion date was never entered. */
  undated: number;
}

function epochToIso(value: unknown): string | null {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * Canopy-affecting activities recorded over the area within the years asked.
 *
 * Filtered by completion year locally rather than in the where clause. FACTS
 * stores the date as an epoch and the records with no completion date at all
 * are the interesting ones: an activity entered but never closed out is a
 * planned treatment whose status is unknown, and a server-side date range
 * would silently drop every one of them. They are counted and reported.
 */
export async function managementActivity(
  bbox: [number, number, number, number],
  years: number[],
  signal?: AbortSignal,
): Promise<ManagementSummary> {
  if (years.length === 0) {
    return { queried: false, activities: [], totalAcres: 0, undated: 0 };
  }

  const collection = await queryGeoJson(FACTS_SERVICE, {
    where: activityFilter(),
    bbox,
    outFields: ["activity", "date_completed", "gis_acres", "method"],
    simplify: 0.0002,
    limit: 400,
    signal,
  });

  const wanted = new Set(years);
  const activities: Activity[] = [];
  let undated = 0;

  for (const feature of collection.features) {
    const properties =
      (feature as { properties?: Record<string, unknown> }).properties ?? {};
    const completed = epochToIso(properties.date_completed);
    if (!completed) {
      undated += 1;
      continue;
    }
    if (!wanted.has(Number(completed.slice(0, 4)))) continue;
    activities.push({
      activity: String(properties.activity ?? "unrecorded"),
      completed,
      acres: Number(properties.gis_acres ?? 0),
      method: (properties.method as string) ?? null,
    });
  }

  activities.sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  return {
    queried: true,
    activities,
    totalAcres: activities.reduce((total, entry) => total + entry.acres, 0),
    undated,
  };
}

/**
 * Whether the area intersects National Forest System land at all.
 *
 * Asked before the activity query so that "no records" can be reported as
 * "outside the jurisdiction" rather than as "no harvest", which is the single
 * most misleading thing this dataset could be made to say.
 */
export async function onNationalForest(
  bbox: [number, number, number, number],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const rows = await queryStats(
      "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_BasicOwnership_01/MapServer/0",
      {
        bbox,
        groupBy: ["OWNERCLASSIFICATION"],
        statistics: [
          {
            statisticType: "count",
            onStatisticField: "OBJECTID",
            outStatisticFieldName: "records",
          },
        ],
        signal,
      },
    );
    return rows.length > 0;
  } catch {
    // If ownership cannot be determined, fall back to querying anyway and let
    // the empty result speak with its caveat attached.
    return true;
  }
}
