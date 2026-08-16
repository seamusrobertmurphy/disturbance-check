import {
  CLASS_LABELS,
  CLASS_PALETTES,
  breaksDeviate,
  cogUrl,
  expiryOf,
  isRemote,
  loadBundle,
  totalFlaggedHa,
  type Bundle,
  type DeliveredLayer,
  type DeliveredPeriod,
} from "../bundle/manifest";
import { paint, readLayer, type RasterLayer } from "../bundle/render";
import { describeDeliveryError, describeError } from "../errors";
import { MapLayerManager, type VectorRole } from "../map/layers";
import {
  ACCEPTED_EXTENSIONS,
  importVectorFile,
  pickFile,
  type ImportedVector,
} from "../vector/import";
import {
  IDS_ATTRIBUTION,
  MTBS_ATTRIBUTION,
  coverageFor,
  fireEvidence,
  insectAndDisease,
  managementRecord,
  yearsCovered,
} from "../reference/corroborate";
import { FACTS_ATTRIBUTION } from "../reference/management";
import { LCMS_PRODUCTS, exportOverlay, withinConus } from "../reference/lcms";
import {
  LANDFIRE_ATTRIBUTION,
  loadCatalogue,
  overlayFor,
  regionFor,
  serviceFor,
} from "../reference/landfire";
import {
  WAYBACK_ATTRIBUTION,
  distinctLooks,
  loadReleases,
  type Look,
} from "../reference/wayback";
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
  record: {
    status: "idle" | "loading" | "ready" | "error";
    fires: Awaited<ReturnType<typeof fireEvidence>> | null;
    ids: Awaited<ReturnType<typeof insectAndDisease>> | null;
    management: Awaited<ReturnType<typeof managementRecord>> | null;
    error: string | null;
  };
  looks: { status: "idle" | "loading" | "ready" | "error"; items: Look[]; active: string | null; error: string | null };
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
    record: { status: "idle", fires: null, ids: null, management: null, error: null },
    looks: { status: "idle", items: [], active: null, error: null },
  };

  private readonly app: GeoLibreAppAPI;

  constructor(app: GeoLibreAppAPI) {
    this.app = app;
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
      if (first && primary) {
        await this.toggleLayer(first, primary);
        // And move to it. A delivery opens on a world map, and the layer it
        // exists to show is a few pixels somewhere in Montana: a client would
        // have to know where the project is before they could see the result.
        // The boundary, where one is supplied, is the better frame; the
        // raster's own extent is the fallback, and it is always there.
        this.frame(this.state.rasters.get(this.layerKey(first, primary))?.bounds);
      }
      if (bundle.boundary) this.drawBoundary(bundle);
    } catch (error) {
      this.patch({ status: "error", error: describeError(error) });
    }
  }

  /**
   * Move the map to the delivery's extent.
   *
   * Optional in the host API, so a host that does not offer it simply leaves
   * the view where it was rather than failing to open the panel.
   */
  private frame(bounds?: [number, number, number, number]): void {
    if (!bounds) return;
    try {
      this.app.fitBounds?.(bounds);
    } catch {
      // A host that refuses to move is not a reason to lose the layer.
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
      this.patch({
        busy: null,
        error: describeDeliveryError(
          error,
          { remote: isRemote(layer) },
          this.state.bundle
            ? expiryOf(this.state.bundle)
            : { on: null, expired: false },
        ),
      });
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
    const expiry = expiryOf(this.state.bundle);
    if (expiry.expired) {
      this.container.appendChild(
        this.notice(
          "warning",
          "This delivery has expired",
          `The rasters were held until ${expiry.on} and have since been deleted, so no layer will draw. Everything below still describes what was produced. Ask for a re-run to have the layers republished.`,
        ),
      );
    } else if (expiry.daysLeft !== null && expiry.daysLeft <= 2) {
      this.container.appendChild(
        this.notice(
          "warning",
          "Expires shortly",
          `These layers are held until ${expiry.on}, ${expiry.daysLeft === 0 ? "today" : `${expiry.daysLeft} day${expiry.daysLeft === 1 ? "" : "s"} from now`}. After that they stop drawing until they are republished.`,
        ),
      );
    }
    this.container.appendChild(this.renderAssessment(this.state.bundle));
    this.container.appendChild(this.renderLayers(this.state.bundle));
    this.container.appendChild(this.renderSiteData());
    this.container.appendChild(this.renderPublicRecord());
    this.container.appendChild(this.renderImagery());
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

  /** Lon/lat bounds of the delivered layers, which every public overlay is
   * requested over. Falls back to the first raster read. */
  private extent(): [number, number, number, number] | null {
    const first = this.state.rasters.values().next().value as
      | RasterLayer
      | undefined;
    return first ? first.bounds : null;
  }

  // The public record ------------------------------------------------------

  private renderPublicRecord(): HTMLElement {
    const body = el("div", "dc-stack");
    const bbox = this.extent();

    if (!bbox) {
      body.appendChild(
        el("p", "dc-hint", "Show a disturbance layer first, so the record can be searched over the same area."),
      );
      return this.section("Public disturbance record", body);
    }

    const coverage = coverageFor(bbox);
    if (coverage.none) {
      body.appendChild(
        this.notice(
          "info",
          "Outside these registries",
          "The fire and forest health registries cover the United States and Canada. This project is outside both, so there is nothing to query. That is a gap in coverage, not an absence of disturbance.",
        ),
      );
      return this.section("Public disturbance record", body);
    }

    const record = this.state.record;
    if (record.status === "idle") {
      body.appendChild(
        el("p", "dc-hint", "Independent records of fire, insect and disease damage and recorded management over this project, from public agency data."),
      );
      body.appendChild(button("Search the record", () => void this.fetchRecord(), "primary"));
      return this.section("Public disturbance record", body);
    }
    if (record.status === "loading") {
      body.appendChild(el("p", "dc-hint", "Querying the public record."));
      return this.section("Public disturbance record", body);
    }
    if (record.status === "error") {
      body.appendChild(this.notice("warning", "The record could not be read", record.error ?? "Unavailable."));
      body.appendChild(button("Try again", () => void this.fetchRecord(), "secondary"));
      return this.section("Public disturbance record", body);
    }

    const fires = record.fires;
    body.appendChild(el("div", "dc-subhead", "Mapped fire"));
    if (!fires || fires.records.length === 0) {
      body.appendChild(el("p", "dc-hint", `No mapped fire intersects this project, according to ${fires?.sources.join(", ") || "the registries that answered"}.`));
    } else {
      for (const fire of fires.records) {
        const row = el("div", "dc-look");
        const head = el("div", "dc-look-head");
        head.appendChild(el("span", "dc-look-date", fire.name));
        head.appendChild(el("span", "dc-look-tag", String(fire.year)));
        head.appendChild(el("span", "dc-look-tag", fire.source));
        row.appendChild(head);
        row.appendChild(el("div", "dc-look-meta", [
          `${formatHectares(fire.hectares)} ha`,
          fire.started ? `from ${fire.started}` : null,
          fire.cause,
        ].filter(Boolean).join(" · ")));
        body.appendChild(row);
      }
      body.appendChild(button("Show perimeters", () => this.showPerimeters(), "secondary"));
    }

    const ids = record.ids;
    body.appendChild(el("div", "dc-subhead", "Insect and disease survey"));
    if (!ids?.covered) {
      body.appendChild(el("p", "dc-hint", "Not surveyed here. The aerial survey is a United States programme."));
    } else if (ids.groups.length === 0) {
      body.appendChild(el("p", "dc-hint", "No damage recorded over this project in these years."));
    } else {
      const table = el("div", "dc-damage");
      for (const group of ids.groups.slice(0, 10)) {
        const row = el("div", "dc-damage-row");
        row.appendChild(el("span", "dc-damage-year", String(group.year)));
        row.appendChild(el("span", "dc-damage-agent", group.agent));
        row.appendChild(el("span", "dc-damage-type", group.damageType));
        row.appendChild(el("span", "dc-damage-acres", `${Math.round(group.acres).toLocaleString()} ac`));
        table.appendChild(row);
      }
      body.appendChild(table);
    }

    const management = record.management;
    if (management) {
      body.appendChild(el("div", "dc-subhead", "Recorded management"));
      if (management.activities.length === 0) {
        body.appendChild(el("p", "dc-hint", "No canopy-affecting activity recorded. The activity tracking system covers National Forest System land only, so on private or state ownership this is an absence of jurisdiction rather than of harvest."));
      } else {
        const table = el("div", "dc-damage");
        for (const activity of management.activities.slice(0, 10)) {
          const row = el("div", "dc-damage-row");
          row.appendChild(el("span", "dc-damage-year", (activity.completed ?? "").slice(0, 4)));
          row.appendChild(el("span", "dc-damage-agent", activity.activity));
          row.appendChild(el("span", "dc-damage-type", activity.completed ?? ""));
          row.appendChild(el("span", "dc-damage-acres", `${Math.round(activity.acres).toLocaleString()} ac`));
          table.appendChild(row);
        }
        body.appendChild(table);
      }
    }

    if (withinConus(bbox)) {
      body.appendChild(el("div", "dc-subhead", "Independent change models"));
      body.appendChild(el("p", "dc-hint", "Built from the same satellite record by unrelated methods. Agreement corroborates the delivered layers; disagreement is worth asking about."));
      const row = el("div", "dc-row");
      for (const product of LCMS_PRODUCTS) {
        row.appendChild(button(product.label, () => void this.showLcms(product.id), "secondary"));
      }
      if (regionFor(bbox)) {
        row.appendChild(button("Disturbance cause", () => void this.showLandfire(), "secondary"));
      }
      body.appendChild(row);
    }

    body.appendChild(el("p", "dc-hint", [MTBS_ATTRIBUTION, IDS_ATTRIBUTION, management ? FACTS_ATTRIBUTION : null, regionFor(bbox) ? LANDFIRE_ATTRIBUTION : null].filter(Boolean).join(". ") + "."));
    return this.section("Public disturbance record", body);
  }

  private async fetchRecord(): Promise<void> {
    const bbox = this.extent();
    const bundle = this.state.bundle;
    if (!bbox || !bundle) return;
    this.patch({ record: { ...this.state.record, status: "loading", error: null } });
    try {
      const years = yearsCovered(bundle.periods);
      const [ids, fires, management] = await Promise.all([
        insectAndDisease(bbox, years),
        fireEvidence(bbox, years),
        managementRecord(bbox, years),
      ]);
      this.patch({ record: { status: "ready", ids, fires, management, error: null } });
    } catch (error) {
      this.patch({ record: { ...this.state.record, status: "error", error: describeError(error) } });
    }
  }

  private showPerimeters(): void {
    const fires = this.state.record.fires;
    if (!fires || fires.perimeters.features.length === 0) return;
    this.layers.addVector({
      key: "record-fire",
      name: "Mapped fire perimeters",
      geojson: fires.perimeters,
      role: "fire",
      labelField: null,
      color: CONTEXT_META.fire.colour,
    });
  }

  private async showLcms(productId: string): Promise<void> {
    const bbox = this.extent();
    const period = this.state.bundle?.periods[0];
    const product = LCMS_PRODUCTS.find((entry) => entry.id === productId);
    if (!bbox || !period || !product) return;
    try {
      const overlay = await exportOverlay({
        product,
        year: Number(period.postEnd.slice(0, 4)),
        bbox,
      });
      this.layers.addRaster({
        key: "record-lcms",
        name: `LCMS ${product.label}`,
        dataUrl: overlay.url,
        coordinates: overlay.coordinates,
        visible: true,
        opacity: 0.75,
      });
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  private async showLandfire(): Promise<void> {
    const bbox = this.extent();
    const period = this.state.bundle?.periods[0];
    const region = bbox ? regionFor(bbox) : null;
    if (!bbox || !period || !region) return;
    try {
      const catalogue = await loadCatalogue();
      const service = serviceFor(catalogue, Number(period.postEnd.slice(0, 4)), region);
      if (!service) {
        this.patch({ error: "LANDFIRE has not published a disturbance product for that year yet." });
        return;
      }
      const overlay = await overlayFor(bbox, service);
      this.layers.addRaster({
        key: "record-landfire",
        name: `LANDFIRE disturbance ${service.year}`,
        dataUrl: overlay.url,
        coordinates: overlay.coordinates,
        visible: true,
        opacity: 0.8,
      });
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  // Dated imagery ----------------------------------------------------------

  private renderImagery(): HTMLElement {
    const body = el("div", "dc-stack");
    const bbox = this.extent();
    if (!bbox) {
      body.appendChild(el("p", "dc-hint", "Show a disturbance layer first."));
      return this.section("High-resolution imagery", body);
    }

    const looks = this.state.looks;
    if (looks.status === "idle") {
      body.appendChild(el("p", "dc-hint", "Every distinct high-resolution photograph of this project in Esri's dated archive, often sub-metre. Sentinel-2 says an index moved; this shows what the ground is."));
      body.appendChild(button("Find available imagery", () => void this.findLooks(), "primary"));
      return this.section("High-resolution imagery", body);
    }
    if (looks.status === "loading") {
      body.appendChild(el("p", "dc-hint", "Reading capture dates, around twenty seconds."));
      return this.section("High-resolution imagery", body);
    }
    if (looks.status === "error") {
      body.appendChild(this.notice("warning", "The archive could not be read", looks.error ?? "Unavailable."));
      return this.section("High-resolution imagery", body);
    }
    if (looks.items.length === 0) {
      body.appendChild(this.notice("warning", "No high-resolution imagery here", "The archive holds no dated capture over this project."));
      return this.section("High-resolution imagery", body);
    }

    for (const look of looks.items) {
      const row = el("div", "dc-look");
      const head = el("div", "dc-look-head");
      head.appendChild(el("span", "dc-look-date", look.capture.captureDate ?? "undated"));
      row.appendChild(head);
      row.appendChild(el("div", "dc-look-meta", [
        look.capture.resolution ? `${look.capture.resolution} m` : null,
        look.capture.source,
        look.capture.provider,
      ].filter(Boolean).join(" · ")));
      row.appendChild(button(
        looks.active === look.capture.captureDate ? "Hide" : "Show",
        () => this.toggleLook(look),
        looks.active === look.capture.captureDate ? "primary" : "secondary",
      ));
      body.appendChild(row);
    }
    body.appendChild(el("p", "dc-hint", `Dates are capture dates read from the archive's own metadata at this location, not release dates. ${WAYBACK_ATTRIBUTION}.`));
    return this.section("High-resolution imagery", body);
  }

  private async findLooks(): Promise<void> {
    const bbox = this.extent();
    if (!bbox) return;
    this.patch({ looks: { ...this.state.looks, status: "loading", error: null } });
    try {
      const releases = await loadReleases();
      const items = await distinctLooks(releases, (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
      this.patch({ looks: { status: "ready", items, active: null, error: null } });
    } catch (error) {
      this.patch({ looks: { ...this.state.looks, status: "error", error: describeError(error) } });
    }
  }

  private toggleLook(look: Look): void {
    const key = "record-wayback";
    if (this.state.looks.active === look.capture.captureDate) {
      this.layers.remove(`tuvsud-dc-${key}`);
      this.patch({ looks: { ...this.state.looks, active: null } });
      return;
    }
    this.layers.addTiles({
      key,
      name: `Imagery ${look.capture.captureDate ?? look.release.releaseDate}`,
      tileUrl: look.release.tileUrl,
      attribution: WAYBACK_ATTRIBUTION,
      visible: true,
      maxzoom: 19,
    });
    this.patch({ looks: { ...this.state.looks, active: look.capture.captureDate } });
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
    const expiry = expiryOf(bundle);
    if (expiry.on) {
      rows.push([
        "Layers held until",
        expiry.expired ? `${expiry.on} (expired)` : expiry.on,
      ]);
    }
    for (const [label, value] of rows) {
      const row = el("div", "dc-prov");
      row.appendChild(el("span", "dc-prov-label", `${label}:`));
      row.appendChild(el("span", "dc-prov-value", ` ${value}`));
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
