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

const plugin: GeoLibrePlugin = {
  id: PANEL_ID,
  name: "Disturbance Check",
  version: "0.1.0",

  activate(app: GeoLibreAppAPI) {
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
