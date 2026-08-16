import { createPanel, type ClientPanel } from "./panel/panel";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./types/geolibre";
import "./style.css";

// Disturbance Check, the delivered viewer.
//
// Sibling of the disturbance checker, with the analysis removed. The layers a
// client sees here were produced by the Earth Engine scripts run in QGIS or
// ArcGIS, exported, and shipped with this build. Nothing in this app can
// change them, which is the point: a client can examine the result and lay
// their own site data over it, but cannot produce a number no verifier signed.

const PANEL_ID = "tuvsud-disturbance-check";

let panel: ClientPanel | null = null;
const teardown: Array<() => void> = [];

/**
 * Swallow one upstream rejection, and only that one.
 *
 * MapLibre queues image requests above `MAX_PARALLEL_IMAGE_REQUESTS`, which is
 * sixteen. When a request settles it does `delete entry.abortController`, and
 * the queue drainer then reads `entry.abortController.signal.aborted` off the
 * entry it just cleared. Every queued basemap tile therefore rejects once with
 * a TypeError, which is why the diagnostics panel opens on exactly sixteen
 * errors over a raster basemap, in this viewer and in the checker alike. The
 * map itself is unaffected: the tiles draw.
 *
 * Verified present in the MapLibre bundled by GeoLibre v1.9.0 and still present
 * in 5.24.0, which the current v2.6.0 ships, so upgrading the host does not
 * clear it and nothing in this repository causes it.
 *
 * Matched narrowly on purpose: the exact message, and a stack that names
 * maplibre. Anything else, including any other TypeError, is left to surface.
 * This hides a known upstream defect, not our own failures.
 */
function silenceImageQueueRejection(): () => void {
  const isQueueBug = (reason: unknown): boolean => {
    if (!(reason instanceof TypeError)) return false;
    const message = reason.message ?? "";
    const stack = reason.stack ?? "";
    return (
      /signal/.test(message) &&
      /undefined|null/.test(message) &&
      /maplibre/i.test(stack)
    );
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    if (isQueueBug(event.reason)) event.preventDefault();
  };

  // A host that offers no event target simply does not get this, rather than
  // failing to activate over a cosmetic fix.
  if (typeof window?.addEventListener !== "function") return () => {};

  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}

const plugin: GeoLibrePlugin = {
  id: PANEL_ID,
  name: "Disturbance Check",
  version: "0.2.1",

  activate(app: GeoLibreAppAPI) {
    teardown.push(silenceImageQueueRejection());
    panel = createPanel(app);

    const registration = {
      id: PANEL_ID,
      title: "Disturbance Check",
      // Takes the Style panel slot so the Layer panel stays visible beside it.
      dock: "replace-style" as const,
      render: (container: HTMLElement) => panel?.mount(container),
      destroy: () => panel?.destroy(),
    };

    if (app.registerRightPanel) {
      teardown.push(app.registerRightPanel(registration));
      app.openRightPanel?.(PANEL_ID);
      return true;
    }
    if (app.registerFloatingPanel) {
      teardown.push(
        app.registerFloatingPanel({
          id: PANEL_ID,
          title: registration.title,
          defaultWidth: 380,
          render: registration.render,
        }),
      );
      app.openFloatingPanel?.(PANEL_ID);
      return true;
    }
    return false;
  },

  deactivate(app: GeoLibreAppAPI) {
    panel?.destroy();
    panel = null;
    while (teardown.length > 0) {
      try {
        teardown.pop()?.();
      } catch {
        // A host that has already torn the surface down is not an error here.
      }
    }
    app.unregisterRightPanel?.(PANEL_ID);
    app.unregisterFloatingPanel?.(PANEL_ID);
  },
};

export default plugin;
