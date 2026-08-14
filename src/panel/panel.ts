import {
  CLASS_LABELS,
  CLASS_PALETTES,
  breaksDeviate,
  cogUrl,
  loadBundle,
  totalFlaggedHa,
  type Bundle,
  type DeliveredLayer,
  type DeliveredPeriod,
} from "../bundle/manifest";
import { paint, readLayer, type RasterLayer } from "../bundle/render";
import { describeError } from "../errors";
import { MapLayerManager, type VectorRole } from "../map/layers";
import {
  ACCEPTED_EXTENSIONS,
  importVectorFile,
  pickFile,
  type ImportedVector,
} from "../vector/import";
import type { GeoLibreAppAPI } from "../types/geolibre";
import { button, clear, el, formatHectares } from "./dom";

// The client panel.
//
// The difference from the checker is what it does not have. There are no
// periods to set, no dates, no cloud ceiling and no severity thresholds,
// because all of that was decided when the analysis was run and is now part of
// the record rather than a control. Presenting them as adjustable would invite
// a client to produce a number that no verifier signed.
//
// What remains is everything a client legitimately needs: the layers, the
// thresholds they were produced under, the public record they can be checked
// against, and the ability to lay their own site data over the top.

const CONTEXT_META: Record<
  VectorRole,
  { label: string; colour: string; hint: string }
> = {
  boundary: {
    label: "Project boundary",
    colour: "#38bdf8",
    hint: "The parcel the analysis was clipped to. Drawn as an outline so nothing is hidden beneath it.",
  },
  smz: {
    label: "Streamside management zones",
    colour: "#34d399",
    hint: "Overlaid to show whether flagged disturbance falls inside a zone where harvest is restricted.",
  },
  plots: {
    label: "Inventory plots",
    colour: "#fbbf24",
    hint: "Plot points with their identifiers, so a screenshot of a flagged polygon can be tied to a plot.",
  },
  fire: {
    label: "Fire perimeters",
    colour: "#d7301f",
    hint: "Mapped fire from the public record.",
  },
};

interface LoadedContext {
  name: string;
  imported: ImportedVector;
}

interface State {
  bundle: Bundle | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  /** Rasters already read, keyed by period and delta. */
  rasters: Map<string, RasterLayer>;
  shown: Set<string>;
  context: Partial<Record<VectorRole, LoadedContext>>;
  busy: string | null;
}

export class ClientPanel {
  private container: HTMLElement | null = null;
  private readonly layers: MapLayerManager;
  private state: State = {
    bundle: null,
    status: "loading",
    error: null,
    rasters: new Map(),
    shown: new Set(),
    context: {},
    busy: null,
  };

  constructor(app: GeoLibreAppAPI) {
    this.layers = new MapLayerManager(app);
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.classList.add("dc-root");
    this.render();
    void this.load();
  }

  destroy(): void {
    this.layers.removeAll();
    if (this.container) clear(this.container);
    this.container = null;
  }

  private patch(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  /** Base for the bundle, resolved against the page rather than the plugin, so
   * a deployment can host the rasters beside its index.html. */
  private baseUrl(): string {
    return new URL("./", window.location.href).href;
  }

  private async load(): Promise<void> {
    try {
      const bundle = await loadBundle(this.baseUrl());
      this.patch({ bundle, status: "ready", error: null });
      // Show the canopy-loss layer of the first period on open. It is the one
      // the SOP treats as primary, and a client opening to a blank map would
      // reasonably wonder whether anything had loaded.
      const first = bundle.periods[0];
      const primary = first?.layers.find((layer) => layer.id === "dNDVI");
      if (first && primary) await this.toggleLayer(first, primary);
      if (bundle.boundary) this.drawBoundary(bundle);
    } catch (error) {
      this.patch({ status: "error", error: describeError(error) });
    }
  }

  private drawBoundary(bundle: Bundle): void {
    this.layers.addVector({
      key: "delivered-boundary",
      name: "Project boundary",
      geojson: bundle.boundary,
      role: "boundary",
      labelField: null,
      color: CONTEXT_META.boundary.colour,
    });
  }

  private layerKey(period: DeliveredPeriod, layer: DeliveredLayer): string {
    return `${period.id}-${layer.id}`;
  }

  private async toggleLayer(
    period: DeliveredPeriod,
    layer: DeliveredLayer,
  ): Promise<void> {
    const key = this.layerKey(period, layer);
    if (this.state.shown.has(key)) {
      this.layers.remove(`tuvsud-dc-${key}`);
      this.state.shown.delete(key);
      this.render();
      return;
    }

    this.patch({ busy: key });
    try {
      let raster = this.state.rasters.get(key);
      if (!raster) {
        raster = await readLayer(cogUrl(this.baseUrl(), layer), layer);
        this.state.rasters.set(key, raster);
      }
      this.layers.addRaster({
        key,
        name: `${period.id} ${layer.label}`,
        dataUrl: paint(raster),
        coordinates: raster.coordinates,
        visible: true,
      });
      this.state.shown.add(key);
      this.patch({ busy: null });
    } catch (error) {
      this.patch({ busy: null, error: describeError(error) });
    }
  }

  // Rendering ---------------------------------------------------------------

  private render(): void {
    if (!this.container) return;
    clear(this.container);

    const intro = el("div", "dc-intro");
    intro.appendChild(
      el(
        "p",
        "dc-intro-text",
        "Canopy disturbance layers produced for this project, with the public record they can be checked against. The layers are as delivered: the periods, thresholds and imagery behind them are fixed and shown below.",
      ),
    );
    this.container.appendChild(intro);

    if (this.state.status === "loading") {
      this.container.appendChild(el("p", "dc-hint", "Loading delivered layers."));
      return;
    }

    if (this.state.status === "error" || !this.state.bundle) {
      this.container.appendChild(
        this.notice(
          "warning",
          "No layers could be loaded",
          this.state.error ?? "This build carries no delivered bundle.",
        ),
      );
      return;
    }

    if (this.state.bundle.sample) {
      this.container.appendChild(
        this.notice(
          "warning",
          "Sample data, not a delivery",
          "These layers are placeholders used to demonstrate the viewer. The disturbance shown is invented and must not be read, cited or reported.",
        ),
      );
    }
    this.container.appendChild(this.renderAssessment(this.state.bundle));
    this.container.appendChild(this.renderLayers(this.state.bundle));
    this.container.appendChild(this.renderSiteData());
    this.container.appendChild(this.renderProvenance(this.state.bundle));
  }

  private section(title: string, body: HTMLElement): HTMLElement {
    const wrapper = el("div", "dc-section");
    wrapper.appendChild(el("div", "dc-section-title", title));
    wrapper.appendChild(body);
    return wrapper;
  }

  private notice(
    severity: "info" | "warning",
    title: string,
    detail: string,
  ): HTMLElement {
    const box = el("div", `dc-notice dc-notice-${severity}`);
    box.appendChild(el("div", "dc-notice-title", title));
    box.appendChild(el("div", "dc-notice-detail", detail));
    return box;
  }

  private renderAssessment(bundle: Bundle): HTMLElement {
    const body = el("div", "dc-stack");
    body.appendChild(
      el("div", "dc-kv", `${bundle.project} · ${bundle.client}`),
    );
    if (bundle.boundaryAreaHa) {
      body.appendChild(
        el(
          "div",
          "dc-hint",
          `Project boundary ${formatHectares(bundle.boundaryAreaHa)} ha. Every figure below is measured inside it.`,
        ),
      );
    }
    for (const period of bundle.periods) {
      body.appendChild(
        el(
          "div",
          "dc-period",
          `${period.id}: ${period.preStart} to ${period.preEnd}, compared with ${period.postStart} to ${period.postEnd}`,
        ),
      );
    }
    for (const warning of bundle.warnings) {
      body.appendChild(this.notice("warning", "Recorded at the time of the run", warning));
    }
    return this.section("What was assessed", body);
  }

  private renderLayers(bundle: Bundle): HTMLElement {
    const body = el("div", "dc-stack");

    for (const period of bundle.periods) {
      for (const layer of period.layers) {
        const key = this.layerKey(period, layer);
        const card = el("div", "dc-layer");

        const head = el("div", "dc-layer-head");
        head.appendChild(el("span", "dc-layer-name", layer.label));
        head.appendChild(
          el("span", "dc-layer-total", `${formatHectares(totalFlaggedHa(layer))} ha`),
        );
        card.appendChild(head);

        const legend = el("div", "dc-legend");
        CLASS_LABELS.forEach((label, index) => {
          const item = el("div", "dc-legend-item");
          const swatch = el("span", "dc-legend-swatch");
          swatch.style.background = CLASS_PALETTES[layer.id][index];
          item.appendChild(swatch);
          item.appendChild(
            el(
              "span",
              "dc-legend-label",
              `${label} ${formatHectares(layer.areasHa[index])} ha`,
            ),
          );
          legend.appendChild(item);
        });
        card.appendChild(legend);

        card.appendChild(
          el(
            "div",
            "dc-layer-breaks",
            `Thresholds applied: Low ${layer.breaks.low}, Moderate ${layer.breaks.moderate}, High ${layer.breaks.high}`,
          ),
        );

        // SOP Step 6 requires a written justification for any deviation from
        // the default breaks. A deviation with no justification is reported as
        // a defect rather than shown as though it were documented.
        if (breaksDeviate(layer)) {
          card.appendChild(
            this.notice(
              layer.justification ? "info" : "warning",
              "Thresholds deviate from the SOP default",
              layer.justification ??
                "No justification was recorded with this delivery. The figures above cannot be read as SOP-compliant until one is supplied.",
            ),
          );
        }

        const busy = this.state.busy === key;
        card.appendChild(
          button(
            busy ? "Loading" : this.state.shown.has(key) ? "Hide" : "Show",
            () => void this.toggleLayer(period, layer),
            this.state.shown.has(key) ? "primary" : "secondary",
          ),
        );

        const raster = this.state.rasters.get(key);
        if (raster) {
          card.appendChild(
            el(
              "div",
              "dc-hint",
              `Delivered at ${raster.nativeScale} m` +
                (raster.downsampled
                  ? `, shown at reduced resolution for display. Areas above are measured on the delivered pixels, not on what is drawn.`
                  : "."),
            ),
          );
        }

        body.appendChild(card);
      }
    }

    return this.section("Disturbance layers", body);
  }

  private renderSiteData(): HTMLElement {
    const body = el("div", "dc-stack");
    body.appendChild(
      el(
        "p",
        "dc-hint",
        `Add your own site data to read against the layers. Accepts ${ACCEPTED_EXTENSIONS}. Nothing is uploaded anywhere: files are read in this browser.`,
      ),
    );

    for (const role of ["boundary", "smz", "plots"] as VectorRole[]) {
      const meta = CONTEXT_META[role];
      const loaded = this.state.context[role];
      const row = el("div", "dc-context");
      row.appendChild(el("div", "dc-context-label", meta.label));
      row.appendChild(el("div", "dc-hint", meta.hint));
      if (loaded) {
        row.appendChild(
          el(
            "div",
            "dc-context-loaded",
            `${loaded.name}, ${loaded.imported.featureCount} feature(s)`,
          ),
        );
      }
      row.appendChild(
        button(
          loaded ? "Replace" : "Add file",
          () => void this.addContext(role),
          "secondary",
        ),
      );
      body.appendChild(row);
    }

    return this.section("Site data", body);
  }

  private async addContext(role: VectorRole): Promise<void> {
    try {
      const file = await pickFile(ACCEPTED_EXTENSIONS);
      if (!file) return;
      const imported = await importVectorFile(file);
      this.state.context[role] = { name: file.name, imported };
      this.layers.addVector({
        key: `context-${role}`,
        name: CONTEXT_META[role].label,
        geojson: imported.geojson,
        role,
        labelField: role === "plots" ? imported.suggestedLabelField : null,
        color: CONTEXT_META[role].colour,
      });
      this.render();
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  private renderProvenance(bundle: Bundle): HTMLElement {
    const body = el("div", "dc-stack");
    const p = bundle.provenance;
    const rows: Array<[string, string]> = [
      ["Produced by", p.script],
      ["Imagery", p.collection],
      ["Cloud removal", p.cloudRemoval],
      ["Pixel size", `${p.scale} m`],
      ["Run", p.runDate],
      ["Analyst", p.analyst],
    ];
    for (const [label, value] of rows) {
      const row = el("div", "dc-prov");
      row.appendChild(el("span", "dc-prov-label", label));
      row.appendChild(el("span", "dc-prov-value", value));
      body.appendChild(row);
    }
    body.appendChild(
      el(
        "p",
        "dc-hint",
        "These layers are a screening aid. They complement, but do not replace, ground plots and developer monitoring reports.",
      ),
    );
    return this.section("How these layers were produced", body);
  }
}

export function createPanel(app: GeoLibreAppAPI): ClientPanel {
  return new ClientPanel(app);
}
