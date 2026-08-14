// shpjs ships no TypeScript definitions. Only the single entry point used by
// src/vector/import.ts is declared: it takes a zipped shapefile as an
// ArrayBuffer and resolves to a FeatureCollection, or to an array of them when
// the archive holds several shapefiles.
declare module "shpjs" {
  const shp: (buffer: ArrayBuffer) => Promise<unknown>;
  export default shp;
}
