// Esri World Imagery Wayback: a dated archive of the high-resolution basemap.
//
// This replaces the Google Earth historical-imagery timeline the SOP leans on
// for visual confirmation, and it needs no account. Esri publishes every
// release of its World Imagery basemap as its own tile set, close to two
// hundred of them, and serves them anonymously with
// `access-control-allow-origin: *`.
//
// Why it matters for a verification: Sentinel-2 at 10 m tells you an index
// changed, and it cannot tell you what you are looking at. Wayback is
// frequently sub-metre, so a cutblock, a road, a landing or a blowdown patch
// is identifiable by eye, and each is dated.
//
// The distinction this module exists to enforce is between the two dates.
// A **release** is when Esri published a version of the basemap. A **capture**
// is when the aircraft or satellite actually took the picture, and it is often
// a year or more earlier and varies from place to place inside one release.
// Citing a release date as if it were a capture date would be a factual error
// in a finding, so the release list is only ever a way of reaching the capture
// metadata, which is queried per location and reported alongside.

export const WAYBACK_CONFIG_URL =
  "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

export interface WaybackRelease {
  /** Esri's release number, which is the first path segment of a tile URL. */
  releaseNumber: string;
  /** Release date as published in the item title, ISO. */
  releaseDate: string;
  /** MapLibre-ready XYZ template. */
  tileUrl: string;
  /** Service holding per-pixel capture metadata for this release. */
  metadataUrl: string | null;
}

interface RawRelease {
  itemID?: string;
  itemTitle?: string;
  itemURL?: string;
  metadataLayerUrl?: string;
}

/**
 * ArcGIS tile paths are ordered level, row, column, which is z, y, x. Writing
 * the template with the placeholders in that order is the whole conversion:
 * MapLibre substitutes by name, not by position.
 */
function toXyzTemplate(itemUrl: string): string {
  return itemUrl
    .replace("{level}", "{z}")
    .replace("{row}", "{y}")
    .replace("{col}", "{x}");
}

const TITLE_DATE = /(\d{4})-(\d{2})-(\d{2})/;

export function parseReleases(raw: Record<string, RawRelease>): WaybackRelease[] {
  const releases: WaybackRelease[] = [];
  for (const [releaseNumber, entry] of Object.entries(raw)) {
    const url = entry.itemURL;
    if (!url || !url.includes("{level}")) continue;
    const match = TITLE_DATE.exec(entry.itemTitle ?? "");
    if (!match) continue;
    releases.push({
      releaseNumber,
      releaseDate: `${match[1]}-${match[2]}-${match[3]}`,
      tileUrl: toXyzTemplate(url),
      metadataUrl: entry.metadataLayerUrl ?? null,
    });
  }
  // Newest first: a verifier almost always wants the most recent look, then
  // steps backwards until the disturbance disappears.
  releases.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  return releases;
}

let cached: Promise<WaybackRelease[]> | null = null;

export function loadReleases(signal?: AbortSignal): Promise<WaybackRelease[]> {
  if (!cached) {
    cached = fetch(WAYBACK_CONFIG_URL, { signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `The Wayback release index returned ${response.status}. The dated basemap is unavailable; the analysis is unaffected.`,
          );
        }
        return response.json() as Promise<Record<string, RawRelease>>;
      })
      .then(parseReleases)
      .catch((error) => {
        // Do not cache a failure: a transient network problem should not
        // disable the timeline for the rest of the session.
        cached = null;
        throw error;
      });
  }
  return cached;
}

export interface CaptureInfo {
  /** When the imagery was actually taken. */
  captureDate: string | null;
  /** Ground sample distance in metres, as published. */
  resolution: string | null;
  /** Sensor or programme, e.g. "WV03". */
  source: string | null;
  /** Provider's friendly name for the product. */
  provider: string | null;
  /** Horizontal accuracy in metres, as published. */
  accuracy: string | null;
}

const EMPTY_CAPTURE: CaptureInfo = {
  captureDate: null,
  resolution: null,
  source: null,
  provider: null,
  accuracy: null,
};

/**
 * The capture metadata at a point, for one release.
 *
 * Identify rather than query, because the metadata is split across fourteen
 * layers by resolution and only the ones visible at the given scale answer.
 * Asking all of them and taking the finest that responds is what produces the
 * number a verifier should quote.
 */
export async function captureAt(
  release: WaybackRelease,
  lon: number,
  lat: number,
  signal?: AbortSignal,
): Promise<CaptureInfo> {
  if (!release.metadataUrl) return EMPTY_CAPTURE;

  const pad = 0.02;
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: "all",
    tolerance: "2",
    mapExtent: `${lon - pad},${lat - pad},${lon + pad},${lat + pad}`,
    imageDisplay: "600,600,96",
    returnGeometry: "false",
    f: "json",
  });

  const response = await fetch(`${release.metadataUrl}/identify?${params}`, {
    signal,
  });
  if (!response.ok) return EMPTY_CAPTURE;

  const payload = (await response.json()) as {
    results?: Array<{ attributes?: Record<string, string> }>;
  };
  const attributes = payload.results?.[0]?.attributes;
  if (!attributes) return EMPTY_CAPTURE;

  return {
    captureDate: normaliseDate(attributes.SRC_DATE2 ?? attributes.SRC_DATE),
    resolution: attributes.SRC_RES ?? null,
    source: attributes.SRC_DESC ?? null,
    provider: attributes.NICE_DESC ?? attributes.NICE_NAME ?? null,
    accuracy: attributes.SRC_ACC ?? null,
  };
}

/** `7/14/2025` or `20250714` to `2025-07-14`. Anything else is passed through
 * unchanged rather than guessed at. */
function normaliseDate(value: string | undefined): string | null {
  if (!value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slashed) {
    return `${slashed[3]}-${slashed[1].padStart(2, "0")}-${slashed[2].padStart(2, "0")}`;
  }
  return value;
}

export interface Look {
  release: WaybackRelease;
  capture: CaptureInfo;
}

/**
 * The distinct looks available over a point.
 *
 * Offering the raw release list would invite the error this module exists to
 * prevent. Releases are global publication events: at Sayward the release of
 * 31 August 2023 carries imagery captured on 8 May 2019, and most consecutive
 * releases carry the identical picture because nothing was reflown there. A
 * verifier stepping through them would see the same trees over and over under
 * five different dates, and would have no way to know which date to write down.
 *
 * So the releases are sampled, the capture date at the point is read for each,
 * and only the first release showing each distinct capture is kept. What comes
 * back is the list of times this place was actually photographed.
 *
 * Sampling rather than exhaustive: the full index is close to two hundred
 * releases and each look costs a request. Sampling every `stride`-th release
 * finds every capture that persisted across more than `stride` releases, which
 * in practice is all of them, at a twentieth of the traffic.
 */
export async function distinctLooks(
  releases: WaybackRelease[],
  lon: number,
  lat: number,
  options: { stride?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<Look[]> {
  const stride = options.stride ?? 6;
  const concurrency = options.concurrency ?? 6;

  const sampled = releases.filter(
    (_, index) => index % stride === 0 || index === releases.length - 1,
  );

  const looks: Array<Look | null> = new Array(sampled.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sampled.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= sampled.length) return;
        const release = sampled[index];
        try {
          const capture = await captureAt(release, lon, lat, options.signal);
          if (capture.captureDate) looks[index] = { release, capture };
        } catch {
          // One unreachable metadata service must not lose the whole timeline.
        }
      }
    }),
  );

  const seen = new Set<string>();
  const distinct: Look[] = [];
  // Releases are newest first, so the first release showing a capture is the
  // most recent one that still carries it. Stepping back from there is what a
  // verifier wants: the newest view of each distinct photograph.
  for (const look of looks) {
    if (!look?.capture.captureDate) continue;
    if (seen.has(look.capture.captureDate)) continue;
    seen.add(look.capture.captureDate);
    distinct.push(look);
  }
  distinct.sort((a, b) =>
    (b.capture.captureDate ?? "").localeCompare(a.capture.captureDate ?? ""),
  );
  return distinct;
}

/**
 * The looks that bracket a pair of reporting windows, by **capture** date.
 *
 * `before` is the newest capture at or before the end of the pre window,
 * `after` the newest at or before the end of the post window. Both may be the
 * same look, and either may be null, when no aerial or satellite pass covered
 * the site in that period. A null here is a real answer and the panel says so
 * rather than falling back to a nearby date.
 */
export function bracketLooks(
  looks: Look[],
  preEnd: string,
  postEnd: string,
): { before: Look | null; after: Look | null; latest: Look | null } {
  const onOrBefore = (date: string) =>
    looks.find((look) => (look.capture.captureDate ?? "") <= date) ?? null;
  return {
    before: onOrBefore(preEnd),
    after: onOrBefore(postEnd),
    latest: looks[0] ?? null,
  };
}

export const WAYBACK_ATTRIBUTION =
  "Esri World Imagery Wayback, Esri, Maxar, Earthstar Geographics";
