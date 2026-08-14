// Reads the vector files a verifier actually has to hand: a zipped shapefile,
// a GeoJSON export, or a KML from Google Earth. Parsing happens entirely in the
// browser; nothing is uploaded anywhere.

export interface FeatureLike {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

export interface FeatureCollectionLike {
  type: "FeatureCollection";
  features: FeatureLike[];
}

export interface ImportedVector {
  geojson: FeatureCollectionLike;
  featureCount: number;
  /** Property keys present on the first feature, for the label field picker. */
  fields: string[];
  /** Best guess at the plot identifier field, if the data looks like points. */
  suggestedLabelField: string | null;
  geometryKinds: string[];
  bounds: [number, number, number, number] | null;
}

export const ACCEPTED_EXTENSIONS = ".geojson,.json,.zip,.kml";

function asCollection(value: unknown): FeatureCollectionLike {
  if (Array.isArray(value)) {
    // shpjs returns an array when a zip holds several shapefiles.
    const features: FeatureLike[] = [];
    for (const entry of value) {
      features.push(...asCollection(entry).features);
    }
    return { type: "FeatureCollection", features };
  }
  const record = value as Record<string, unknown> | null;
  if (record?.type === "FeatureCollection" && Array.isArray(record.features)) {
    return record as unknown as FeatureCollectionLike;
  }
  if (record?.type === "Feature") {
    return { type: "FeatureCollection", features: [record as unknown as FeatureLike] };
  }
  if (record?.type && record.coordinates) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: record as unknown as FeatureLike["geometry"],
          properties: {},
        },
      ],
    };
  }
  throw new Error("The file did not contain recognisable GeoJSON features.");
}

function parseKmlCoordinates(text: string): number[][] {
  return text
    .trim()
    .split(/\s+/)
    .map((triple) => {
      const [lon, lat] = triple.split(",").map(Number);
      return [lon, lat];
    })
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function parseKml(text: string): FeatureCollectionLike {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("The KML file could not be parsed.");
  }

  const features: FeatureLike[] = [];
  for (const placemark of Array.from(doc.getElementsByTagName("Placemark"))) {
    const properties: Record<string, unknown> = {};
    const name = placemark.getElementsByTagName("name")[0]?.textContent;
    if (name) properties.name = name.trim();
    for (const data of Array.from(placemark.getElementsByTagName("SimpleData"))) {
      const key = data.getAttribute("name");
      if (key) properties[key] = data.textContent?.trim() ?? "";
    }
    for (const data of Array.from(placemark.getElementsByTagName("Data"))) {
      const key = data.getAttribute("name");
      const value = data.getElementsByTagName("value")[0]?.textContent;
      if (key) properties[key] = value?.trim() ?? "";
    }

    const point = placemark.getElementsByTagName("Point")[0];
    const line = placemark.getElementsByTagName("LineString")[0];
    const polygon = placemark.getElementsByTagName("Polygon")[0];

    if (point) {
      const coords = parseKmlCoordinates(
        point.getElementsByTagName("coordinates")[0]?.textContent ?? "",
      );
      if (coords.length) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[0] },
          properties,
        });
      }
    } else if (polygon) {
      const rings: number[][][] = [];
      for (const ring of Array.from(polygon.getElementsByTagName("coordinates"))) {
        const coords = parseKmlCoordinates(ring.textContent ?? "");
        if (coords.length >= 4) rings.push(coords);
      }
      if (rings.length) {
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: rings },
          properties,
        });
      }
    } else if (line) {
      const coords = parseKmlCoordinates(
        line.getElementsByTagName("coordinates")[0]?.textContent ?? "",
      );
      if (coords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties,
        });
      }
    }
  }

  if (features.length === 0) {
    throw new Error("The KML file contained no points, lines or polygons.");
  }
  return { type: "FeatureCollection", features };
}

/**
 * Ranked guesses at the plot identifier. Verifiers name this field many ways,
 * and getting it wrong means unlabelled points on every screenshot, so the
 * detected field is always shown and always overridable.
 */
const LABEL_PATTERNS: Array<{ test: RegExp; score: number }> = [
  { test: /^plot[\s_-]*(id|no|num|number)$/i, score: 100 },
  { test: /^plot$/i, score: 90 },
  { test: /^(id|name)[\s_-]*plot$/i, score: 85 },
  { test: /plot/i, score: 70 },
  { test: /^(point|site|stand)[\s_-]*(id|no|num|number)$/i, score: 60 },
  { test: /^(id|fid|objectid|name|label)$/i, score: 40 },
];

export function detectLabelField(fields: string[]): string | null {
  let best: { field: string; score: number } | null = null;
  for (const field of fields) {
    for (const pattern of LABEL_PATTERNS) {
      if (pattern.test.test(field)) {
        if (!best || pattern.score > best.score) {
          best = { field, score: pattern.score };
        }
        break;
      }
    }
  }
  return best?.field ?? null;
}

function walkCoordinates(
  coordinates: unknown,
  visit: (lon: number, lat: number) => void,
): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    visit(coordinates[0], coordinates[1]);
    return;
  }
  for (const entry of coordinates) walkCoordinates(entry, visit);
}

export function boundsOf(
  collection: FeatureCollectionLike,
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const feature of collection.features) {
    walkCoordinates(feature.geometry?.coordinates, (lon, lat) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    });
  }

  if (!Number.isFinite(west) || !Number.isFinite(north)) return null;
  return [west, south, east, north];
}

export async function importVectorFile(file: File): Promise<ImportedVector> {
  const name = file.name.toLowerCase();
  let collection: FeatureCollectionLike;

  if (name.endsWith(".zip")) {
    const shp = (await import("shpjs")).default as (
      buffer: ArrayBuffer,
    ) => Promise<unknown>;
    collection = asCollection(await shp(await file.arrayBuffer()));
  } else if (name.endsWith(".kml")) {
    collection = parseKml(await file.text());
  } else if (name.endsWith(".geojson") || name.endsWith(".json")) {
    collection = asCollection(JSON.parse(await file.text()));
  } else {
    throw new Error(
      "Unsupported file type. Use a zipped shapefile, a GeoJSON file, or a KML file.",
    );
  }

  if (collection.features.length === 0) {
    throw new Error("The file contained no features.");
  }

  const fields = new Set<string>();
  const geometryKinds = new Set<string>();
  for (const feature of collection.features.slice(0, 50)) {
    for (const key of Object.keys(feature.properties ?? {})) fields.add(key);
    if (feature.geometry?.type) geometryKinds.add(feature.geometry.type);
  }
  const fieldList = [...fields];

  return {
    geojson: collection,
    featureCount: collection.features.length,
    fields: fieldList,
    suggestedLabelField: detectLabelField(fieldList),
    geometryKinds: [...geometryKinds],
    bounds: boundsOf(collection),
  };
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = accept;
    picker.addEventListener("change", () => {
      resolve(picker.files?.[0] ?? null);
    });
    // Safari needs the element in the document for the change event to fire.
    picker.style.display = "none";
    document.body.appendChild(picker);
    picker.click();
    setTimeout(() => picker.remove(), 60_000);
  });
}
