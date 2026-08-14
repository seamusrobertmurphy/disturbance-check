import { exportImageOverlay, serviceLegend, type LegendEntry } from "./arcgis";

// LANDFIRE annual disturbance.
//
// The closest thing to a cause layer that exists wall to wall. Where LCMS says
// change happened and how fast, LANDFIRE names the agent: its legend carries
// Fire, Clearcut, Harvest, Thinning, Mastication, Other Mechanical, Insects,
// Disease, Weather and Development as distinct classes.
//
// That specificity is why it earns a place alongside LCMS rather than
// replacing it. Two products built by different teams from overlapping inputs
// agreeing on a stand is worth more than either alone, and where they disagree
// the disagreement is the thing to chase.
//
// Conterminous states and Alaska. Products are published per year and the
// service naming carries both the release and the disturbance year, so the
// catalogue is read at runtime rather than a naming convention assumed.

const LANDFIRE_FOLDER =
  "https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance";

export const LANDFIRE_ATTRIBUTION =
  "LANDFIRE annual disturbance, USGS and USDA Forest Service";

export type LandfireRegion = "CONUS" | "AK";

export interface LandfireService {
  /** Disturbance year the product describes. */
  year: number;
  region: LandfireRegion;
  url: string;
  /** Release the product was published in, used to break ties. */
  release: number;
}

// LF2023_Dist23_CONUS: release 2023, disturbance year 2023, conterminous.
// The LDist and PDist variants are fuel-disturbance derivatives rather than
// the annual disturbance product itself and are deliberately not offered.
const SERVICE_NAME = /^LF(\d{4})_Dist(\d{2})_(CONUS|AK)$/;

let catalogue: Promise<LandfireService[]> | null = null;

export function loadCatalogue(
  signal?: AbortSignal,
): Promise<LandfireService[]> {
  if (!catalogue) {
    catalogue = fetch(`${LANDFIRE_FOLDER}?f=json`, { signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `The LANDFIRE catalogue returned ${response.status}. The overlay is unavailable; the analysis is unaffected.`,
          );
        }
        return response.json() as Promise<{
          services?: Array<{ name: string }>;
        }>;
      })
      .then((payload) => {
        const services: LandfireService[] = [];
        for (const entry of payload.services ?? []) {
          const name = entry.name.split("/").pop() ?? "";
          const match = SERVICE_NAME.exec(name);
          if (!match) continue;
          const suffix = Number(match[2]);
          services.push({
            release: Number(match[1]),
            // Two-digit disturbance years run from 1999. Anything below 50 is
            // this century; the product does not reach 2050 and the archive
            // starts at 99.
            year: suffix < 50 ? 2000 + suffix : 1900 + suffix,
            region: match[3] as LandfireRegion,
            url: `${LANDFIRE_FOLDER}/${name}/ImageServer`,
          });
        }
        return services;
      })
      .catch((error) => {
        catalogue = null;
        throw error;
      });
  }
  return catalogue;
}

/**
 * The service describing a given disturbance year.
 *
 * Where a year appears under more than one release, the newest wins: LANDFIRE
 * revises earlier years as its methods change, and the current release is what
 * the agency stands behind.
 */
export function serviceFor(
  services: LandfireService[],
  year: number,
  region: LandfireRegion,
): LandfireService | null {
  const matches = services
    .filter((service) => service.year === year && service.region === region)
    .sort((a, b) => b.release - a.release);
  return matches[0] ?? null;
}

/** Disturbance years the catalogue publishes for a region, newest first. */
export function availableYears(
  services: LandfireService[],
  region: LandfireRegion,
): number[] {
  const years = new Set(
    services.filter((s) => s.region === region).map((s) => s.year),
  );
  return [...years].sort((a, b) => b - a);
}

export interface LandfireOverlay {
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  legend: LegendEntry[];
  service: LandfireService;
  release: () => void;
}

export async function overlayFor(
  bbox: [number, number, number, number],
  service: LandfireService,
  signal?: AbortSignal,
): Promise<LandfireOverlay> {
  const [west, south, east, north] = bbox;
  const width = 1024;
  const height = Math.max(
    1,
    Math.round(width * ((north - south) / (east - west))),
  );

  const [{ url, release }, legend] = await Promise.all([
    exportImageOverlay({
      serviceUrl: service.url,
      bbox: [west, south, east, north],
      epsg: 4326,
      width,
      height,
      signal,
    }),
    serviceLegend(service.url, signal),
  ]);

  return {
    url,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    legend,
    service,
    release,
  };
}

/** Alaska or the conterminous states, from the AOI. Returns null outside both,
 * where no LANDFIRE product applies. */
export function regionFor(
  bbox: [number, number, number, number],
): LandfireRegion | null {
  const [west, south, east, north] = bbox;
  const overlaps = (w: number, s: number, e: number, n: number) =>
    west < e && east > w && south < n && north > s;
  if (overlaps(-125.1, 24.4, -66.9, 49.4)) return "CONUS";
  if (overlaps(-179.2, 51.2, -129.9, 71.5)) return "AK";
  return null;
}
