import { GeoLibreAppAPI } from "../types/geolibre";

// GeoLibreAppAPI exposes no removeLayer, so a layer created through
// addGeoJsonLayer or addTileLayer can never be taken away again. Because this
// tool re-runs repeatedly within a session, every layer it creates is drawn
// directly on the MapLibre instance and registered with
// registerExternalNativeLayer, which does have an unregister counterpart. That
// keeps the Layer panel in charge of visibility, opacity and ordering while
// leaving removal under the plugin's control.

interface MapLibreLike {
  addSource: (id: string, source: Record<string, unknown>) => void;
  removeSource: (id: string) => void;
  getSource: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  setPaintProperty?: (id: string, name: string, value: unknown) => void;
  setLayoutProperty?: (id: string, name: string, value: unknown) => void;
  isStyleLoaded?: () => boolean;
  once?: (event: string, handler: () => void) => void;
}

export type VectorRole = "boundary" | "smz" | "plots" | "fire";

export interface ManagedLayer {
  id: string;
  sourceIds: string[];
  nativeLayerIds: string[];
}

const PREFIX = "tuvsud-dc";

export class MapLayerManager {
  private managed = new Map<string, ManagedLayer>();

  constructor(private readonly app: GeoLibreAppAPI) {}

  private map(): MapLibreLike | null {
    const map = this.app.getMap?.() as MapLibreLike | null | undefined;
    if (!map || typeof map.addSource !== "function") return null;
    return map;
  }

  private ready(map: MapLibreLike): boolean {
    return map.isStyleLoaded ? map.isStyleLoaded() : true;
  }

  /**
   * Whether a source and layer really landed on the map.
   *
   * The Layer panel is driven by what this manager registers, so registering
   * something MapLibre silently refused makes the panel lie. Checking is two
   * lookups and it turns an invisible failure into a visible one.
   */
  private settled(
    map: MapLibreLike,
    sourceId: string,
    layerId: string,
  ): boolean {
    try {
      if (map.getSource(sourceId) && map.getLayer(layerId)) return true;
    } catch {
      // Fall through to the cleanup below.
    }
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch {
      // Nothing more to do; the style rejected it.
    }
    return false;
  }

  /** Remove every layer this plugin created whose id starts with the prefix. */
  removeByPrefix(prefix: string): void {
    for (const id of [...this.managed.keys()]) {
      if (id.startsWith(prefix)) this.remove(id);
    }
  }

  removeAll(): void {
    for (const id of [...this.managed.keys()]) this.remove(id);
  }

  remove(id: string): void {
    const entry = this.managed.get(id);
    if (!entry) return;
    this.app.unregisterExternalNativeLayer?.(id);

    const map = this.map();
    if (map) {
      for (const layerId of entry.nativeLayerIds) {
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        } catch {
          // The style may have been swapped underneath us.
        }
      }
      for (const sourceId of entry.sourceIds) {
        try {
          if (map.getSource(sourceId)) map.removeSource(sourceId);
        } catch {
          // Same.
        }
      }
    }
    this.managed.delete(id);
  }

  /**
   * Add a result raster.
   *
   * There is no tile server any more. The analysis runs in this tab, so each
   * layer arrives as one already-painted image pinned to the four corners of
   * the AOI. Undisturbed pixels are painted transparent, so the basemap shows
   * through wherever nothing was detected, exactly as the masked tiles did.
   */
  addRaster(options: {
    key: string;
    name: string;
    dataUrl: string;
    coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
    visible: boolean;
    opacity?: number;
  }): void {
    const map = this.map();
    if (!map) return;
    const id = `${PREFIX}-${options.key}`;
    this.remove(id);

    const sourceId = `${id}-src`;
    const layerId = `${id}-lyr`;

    const draw = () => {
      try {
        // An image source takes a url and four corners and nothing else.
        // MapLibre validates the style before it builds the source, so an
        // extra property is not ignored: the source is rejected outright and
        // every layer that names it then fails with "source not found". An
        // `attribution` here cost twelve invisible layers. Attribution for
        // this imagery lives in the run manifest, which is where a finding
        // cites it from anyway.
        map.addSource(sourceId, {
          type: "image",
          url: options.dataUrl,
          coordinates: options.coordinates,
        });
        map.addLayer({
          id: layerId,
          type: "raster",
          source: sourceId,
          layout: { visibility: options.visible ? "visible" : "none" },
          paint: { "raster-opacity": options.opacity ?? 1 },
        });
      } catch {
        return;
      }

      // MapLibre reports a rejected source through an error event rather than
      // by throwing, so the try above catches nothing and the layer is left
      // naming a source that was never built. Registering it anyway would put
      // a row in the Layer panel for something that does not exist on the map,
      // which is how twelve invisible layers looked like a rendering problem
      // instead of a style error.
      if (!this.settled(map, sourceId, layerId)) return;

      this.managed.set(id, {
        id,
        sourceIds: [sourceId],
        nativeLayerIds: [layerId],
      });
      this.app.registerExternalNativeLayer?.({
        id,
        name: options.name,
        type: "raster",
        nativeLayerIds: [layerId],
        sourceIds: [sourceId],
        opacity: options.opacity ?? 1,
        metadata: { sourceKind: "tuvsud-disturbance-check", ephemeral: true },
      });
    };

    if (this.ready(map)) draw();
    else map.once?.("styledata", draw);
  }

  /**
   * Add a tiled raster from an external service.
   *
   * Separate from addRaster because the two have opposite lifetimes and
   * opposite places in the stack. A result raster is one image this tab
   * painted and belongs on top; a reference basemap is a tile service and
   * belongs underneath everything, including the analysis it is there to
   * corroborate.
   */
  addTiles(options: {
    key: string;
    name: string;
    tileUrl: string;
    attribution: string;
    visible: boolean;
    opacity?: number;
    maxzoom?: number;
    beforeId?: string;
  }): void {
    const map = this.map();
    if (!map) return;
    const id = `${PREFIX}-${options.key}`;
    this.remove(id);

    const sourceId = `${id}-src`;
    const layerId = `${id}-lyr`;

    const draw = () => {
      try {
        map.addSource(sourceId, {
          type: "raster",
          tiles: [options.tileUrl],
          tileSize: 256,
          maxzoom: options.maxzoom ?? 19,
          attribution: options.attribution,
        });
        map.addLayer(
          {
            id: layerId,
            type: "raster",
            source: sourceId,
            layout: { visibility: options.visible ? "visible" : "none" },
            paint: { "raster-opacity": options.opacity ?? 1 },
          },
          options.beforeId,
        );
      } catch {
        return;
      }

      if (!this.settled(map, sourceId, layerId)) return;

      this.managed.set(id, {
        id,
        sourceIds: [sourceId],
        nativeLayerIds: [layerId],
      });
      this.app.registerExternalNativeLayer?.({
        id,
        name: options.name,
        type: "raster",
        nativeLayerIds: [layerId],
        sourceIds: [sourceId],
        opacity: options.opacity ?? 1,
        metadata: { sourceKind: "tuvsud-disturbance-check-reference" },
      });
    };

    if (this.ready(map)) draw();
    else map.once?.("styledata", draw);
  }

  /**
   * Set the opacity of a layer this manager created, without rebuilding it.
   *
   * The before-and-after blend moves this on every frame of a drag, so it has
   * to be a paint-property write rather than a re-add. Re-adding an image
   * source per frame flickers, because the browser re-decodes the PNG.
   */
  setOpacity(key: string, opacity: number): void {
    const map = this.map();
    const entry = this.managed.get(`${PREFIX}-${key}`);
    if (!map || !entry) return;
    for (const layerId of entry.nativeLayerIds) {
      try {
        if (map.getLayer(layerId)) {
          map.setPaintProperty?.(layerId, "raster-opacity", opacity);
        }
      } catch {
        // The style may have been swapped underneath us.
      }
    }
  }

  /** Show or hide a layer this manager created. */
  setVisible(key: string, visible: boolean): void {
    const map = this.map();
    const entry = this.managed.get(`${PREFIX}-${key}`);
    if (!map || !entry) return;
    for (const layerId of entry.nativeLayerIds) {
      try {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty?.(layerId, "visibility", visible ? "visible" : "none");
        }
      } catch {
        // Same.
      }
    }
  }

  /**
   * Add an uploaded context layer. Plot points carry a label drawn from the
   * detected identifier field, so any screenshot taken of a disturbance polygon
   * can be tied to a plot without a separate legend.
   */
  addVector(options: {
    key: string;
    name: string;
    geojson: unknown;
    role: VectorRole;
    labelField?: string | null;
    color: string;
  }): void {
    const map = this.map();
    if (!map) return;
    const id = `${PREFIX}-${options.key}`;
    this.remove(id);

    const sourceId = `${id}-src`;
    const nativeLayerIds: string[] = [];

    const draw = () => {
      try {
        map.addSource(sourceId, { type: "geojson", data: options.geojson });

        if (options.role === "plots") {
          const circleId = `${id}-circle`;
          // Plots are orientation, not evidence. They exist so a screenshot
          // of a disturbance polygon can be tied to a plot number, and a
          // marker heavy enough to sit on top of the classified raster
          // obscures the thing being screenshotted. Small, semi-transparent
          // and a hairline stroke: findable when looked for, invisible when
          // not.
          map.addLayer({
            id: circleId,
            type: "circle",
            source: sourceId,
            paint: {
              "circle-radius": 3,
              "circle-color": options.color,
              "circle-opacity": 0.65,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 0.75,
              "circle-stroke-opacity": 0.7,
            },
          });
          nativeLayerIds.push(circleId);

          if (options.labelField) {
            const labelId = `${id}-label`;
            map.addLayer({
              id: labelId,
              type: "symbol",
              source: sourceId,
              layout: {
                "text-field": ["to-string", ["get", options.labelField]],
                "text-size": 10,
                "text-anchor": "top",
                "text-offset": [0, 0.8],
                // Plot identifiers must stay readable when points cluster, so
                // collision hiding is disabled deliberately.
                "text-allow-overlap": true,
                "text-ignore-placement": false,
              },
              paint: {
                "text-color": "#ffffff",
                "text-opacity": 0.8,
                "text-halo-color": "#000000",
                "text-halo-width": 1.4,
              },
            });
            nativeLayerIds.push(labelId);
          }
        } else {
          const fillId = `${id}-fill`;
          const lineId = `${id}-line`;
          // The project boundary is drawn as an outline and nothing else.
          // A wash over the whole project, however faint, sits between the
          // verifier and every classified cell inside it, which is the entire
          // area they are there to look at. Zones and fire perimeters keep a
          // fill because they are read as areas rather than looked through.
          if (options.role !== "boundary") {
            map.addLayer({
              id: fillId,
              type: "fill",
              source: sourceId,
              paint: {
                "fill-color": options.color,
                // A fire perimeter is evidence to read the analysis against,
                // so it is drawn heavier than a context outline but still
                // light enough to see the classified raster through.
                "fill-opacity": options.role === "smz" ? 0.18 : 0.22,
              },
            });
          }
          map.addLayer({
            id: lineId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": options.color,
              "line-width": options.role === "boundary" ? 2.5 : 1.5,
              "line-dasharray":
                options.role === "smz" ? [3, 2] : options.role === "fire" ? [4, 2] : [1, 0],
            },
          });
          if (options.role !== "boundary") nativeLayerIds.push(fillId);
          nativeLayerIds.push(lineId);
        }
      } catch {
        return;
      }

      this.managed.set(id, { id, sourceIds: [sourceId], nativeLayerIds });
      this.app.registerExternalNativeLayer?.({
        id,
        name: options.name,
        type: "geojson",
        nativeLayerIds,
        sourceIds: [sourceId],
        geojson: options.geojson,
        style: options.labelField
          ? {
              labels: {
                enabled: true,
                field: options.labelField,
                size: 12,
                color: "#ffffff",
                haloColor: "#000000",
                haloWidth: 1.6,
                allowOverlap: true,
                anchor: "top",
                offsetY: 0.7,
              },
            }
          : undefined,
        metadata: {
          sourceKind: "tuvsud-disturbance-check-context",
          role: options.role,
        },
      });
    };

    if (this.ready(map)) draw();
    else map.once?.("styledata", draw);
  }

  has(key: string): boolean {
    return this.managed.has(`${PREFIX}-${key}`);
  }
}

export const RASTER_PREFIX = `${PREFIX}-r-`;
export const rasterKey = (suffix: string): string => `r-${suffix}`;
