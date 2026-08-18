# Disturbance Check

Delivered Sentinel-2 canopy disturbance layers for ACR IFM verification, as a
browser-based [GeoLibre](https://github.com/opengeos/GeoLibre) plugin.

This app computes nothing. The differenced index layers it shows were produced
offline by a verifier, written as cloud-optimised GeoTIFFs, and shipped with the
build. A client can open the result, lay their own boundary, streamside zones
and plot points over it, and check it against the public disturbance record.
They cannot produce a number no verifier signed.

Outputs complement, but do not replace, ground plots and developer monitoring
reports.

## Parent tool

[`disturbance-checker`](https://github.com/seamusrobertmurphy/disturbance-checker)
is the interactive tool. An operator gives it an area of interest and one or
more reporting periods, and it runs the entire analysis in the browser tab:
scene search, cloud masking, compositing, indices, deltas, histograms,
classification and areas. This repository is that tool with the analysis removed
and the record kept.

The two are siblings, not versions. Neither replaces the other, and the
separation is the point: what is adjustable in the checker is settled here.

| | `disturbance-checker` | `disturbance-check` |
|---|---|---|
| Audience | The verifier running the check | The client and the reviewer reading it |
| Imagery | Read live from Earth Search and the AWS COGs, in the tab | Read once, offline, by `scripts/build-bundle.py` |
| Periods and cloud ceiling | Controls in the panel | Fixed in the manifest, shown as record |
| Severity thresholds | Editable before a run, draggable on the histogram after | Printed with the layer, and flagged where they deviate |
| Histograms | Live, per delta, with the breaks drawn on them | None |
| Layers | Twelve painted per period, including RGB context | Three classified rasters per period, preloaded |
| Site data | Uploaded in the browser, never sent anywhere | The same |
| Public record | Present | The same |
| Manifest | Written at the end of a run | Shipped with the rasters, checked at build |
| Guard | None needed | `npm test` fails the build if an analysis control string reaches the bundle |

That last row is the load-bearing one. The smoke test greps the built bundle for
`Cloud ceiling`, `Run check` and `Severity thresholds`, and refuses the build if
any of them appears. Without it the two apps drift back together one convenience
at a time.

## The panel

Six sections, in order:

1. **What was assessed**: project, client, the windows that were differenced,
   and every warning the run recorded, carried through verbatim.
2. **Disturbance layers**: one card per delta per period, with hectares by
   class, the thresholds applied, and a show or hide button.
3. **Site data**: project boundary, streamside management zones and plot
   points, from a zipped shapefile, GeoJSON or KML.
4. **Public disturbance record**: independent registries queried over the same
   extent.
5. **High-resolution imagery**: the dated Esri Wayback archive.
6. **How these layers were produced**: the provenance block from the manifest.

The panel opens on the delivery rather than on the world. It shows the first
period's dNDVI, reads its extent, and moves the map there, because a client
should not have to know where the project is before they can see the result.

## The bundle

A delivery is `public/bundle/manifest.json` plus one classified GeoTIFF per
delta per period, carrying class numbers 0 to 3 rather than colours. Numbers,
not pixels of paint, so the viewer can report the class under the cursor and
total hectares inside a boundary uploaded afterwards.

The manifest is provenance, not decoration. It records which windows were
differenced, which thresholds were applied, hectares per class, who ran it and
when, how cloud was removed, and any warning raised. Three rules keep it honest:

- Areas are measured off the delivered rasters, never asserted by a config. The
  smoke test opens each raster and fails where the manifest claims hectares of a
  class the raster holds no pixels of. That is not hypothetical: the first
  sample shipped 1240.5, 318.2 and 402.7 hectares for a raster holding 6132.8,
  2383.8 and 4083.7, repeated across all three layers, and nothing on screen
  looked wrong.
- A threshold off its SOP Step 6 default marks the layer as deviating. With a
  written justification the panel prints it; without one the panel says the
  figures cannot be read as SOP-compliant.
- A demonstration bundle sets `sample: true` and the panel says so on its face,
  because invented disturbance and real disturbance look identical.

Rasters may ship beside the app or stream from a bucket. Where they are remote
the manifest must name an expiry date, so a client meeting a dead link is told
the delivery expired rather than shown a network error.

## Producing layers

`scripts/build-bundle.py` produces a delivery, and does so with no account of
any kind. Scenes are found through Element 84's public Earth Search catalogue
and pixels are read straight out of the Sentinel-2 L2A cloud-optimised GeoTIFFs
on AWS Open Data. Both answer anonymous requests: no sign-in, no Cloud project,
no OAuth client, no billing.

```bash
python3 scripts/build-bundle.py --config docs/blackfeet-rp3.config.json
```

The method follows the SOP and the checker, so a client comparing the two sees
the same arithmetic:

| Step | What happens |
|---|---|
| Radiometry | DN divided by 10000, with the +1000 baseline offset removed from any scene the catalogue reports still carrying it, read per scene rather than inferred from its date |
| Cloud | OmniCloudMask, a segmentation model, decided at 40 m; snow, saturated and no-data from the Sen2Cor scene classification |
| Compositing | Per-pixel median over surviving observations |
| Indices | NDVI (B8, B4), NDMI (B8, B11), NBR (B8A, B12) |
| Deltas | dNDVI and dNDMI pre minus post, dNBR post minus pre |
| Water | Masked at the delta stage, from SCL, majority across the window |
| Grid | The scenes' own UTM at 20 m, so an area is a pixel count times a constant and no reprojection touches a number |

It needs rasterio, numpy and onnxruntime, plus the ONNX models that
`scripts/export-cloud-model.py` fetches and converts. None of that ships with
the app, which carries no model and runs no inference.

Two other routes exist for layers produced elsewhere.
`scripts/prepare-bundle.mjs` converts Earth Engine exports on disk into COGs and
writes the manifest beside them. `scripts/prepare-remote-bundle.mjs` points a
manifest at objects already in a bucket, and refuses to write one unless every
object is reachable anonymously, answers range requests, sends CORS for the
viewer's origin, has overviews built by copying rather than averaging, and opens
with the same library the viewer uses.

## Public record

The index arithmetic says a delta moved. It cannot say why. The panel queries
the registries that answer the why, over the same extent as the layers:

- **LCMS**, the Forest Service Landscape Change Monitoring System, an annual
  wall-to-wall classification of change derived by a method unlike this one.
- **LANDFIRE** annual disturbance, whose legend names the agent: fire,
  clearcut, harvest, thinning, insects, disease, weather, development.
- **Fire**, from three registries with different lags and different borders.
  MTBS assesses severity from imagery a year or more later. The interagency
  perimeter feed is same-season. The National Burned Area Composite covers
  Canada from 1972.
- **Insect and disease** survey polygons, an aerial observer's record.
- **FACTS**, the record of what was actually done, with a date and an acreage.
  National Forest System land only, so an absence here is very often an absence
  of jurisdiction rather than an absence of harvest, and the panel says so.
- **Esri World Imagery Wayback**, a dated archive of the high-resolution
  basemap, frequently sub-metre, which replaces the Google Earth historical
  timeline the SOP leans on. Release date and capture date are reported
  separately, because citing one as the other would be a factual error in a
  finding.

All of these answer anonymous requests and reflect the calling origin in
`access-control-allow-origin`, which is the only reason they can be in a
browser-only tool. They corroborate and are never inputs: nothing in the
calculation depends on another party's model.

## What ships

The bundle in `public/bundle` is a real delivery, not a sample: RP3 of the
ILTF/NICC and Blackfeet Indian Nation Forest Carbon Project (ACR782), July to
August 2023 differenced against July to August 2024, produced on 2026-08-16 at
20 m over 1,184,517 ha.

It carries its own warnings, and they are the kind that matter. The differenced
windows close before RP3 opens. Areas are measured over the project's bounding
rectangle rather than its boundary. dNBR flags 14.0 percent of the area
analysed, which over ground that is not wholly forest is more consistent with
seasonal difference between the two windows than with disturbance.

## Deployment

The published site is a GeoLibre web build with this plugin baked in, served
from GitHub Pages. GeoLibre is not vendored here. The workflow checks it out at
a pinned tag, drops in the built plugin, copies `public/bundle` to the site
root, builds and publishes. Bump `GEOLIBRE_REF` in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) to move to a
newer GeoLibre.

No secrets are involved, because there is no credential to inject.

The deploy also writes a startup project and injects a small snippet into
`index.html`, so a visitor arrives with the plugin already switched on, a dark
theme, and a satellite basemap rather than a road map. Every layer this tool
draws is evidence about vegetation, and imagery is what a verifier can check it
against. All three are defaults: an explicit `?theme=light` or `?project=` still
wins.

## Development

```bash
npm install
npm run build     # typecheck, then bundle to dist/
npm test          # load the bundle, assert the plugin contract, check the manifest against its rasters
```

The plugin is one self-contained ES module because GeoLibre's external-plugin
loader executes the entry through a blob import and does not resolve relative
imports inside the bundle. Its three runtime dependencies are `geotiff` for
reading cloud-optimised GeoTIFFs, `proj4` for the UTM transforms and `shpjs`
for boundary imports, all MIT.

One upstream defect is silenced on activation, and only that one. MapLibre
queues image requests above sixteen, deletes an entry's abort controller when
the request settles, then reads `signal.aborted` off the entry it just cleared,
so every queued basemap tile rejects once with a TypeError. It is matched on the
exact message and a stack naming maplibre; anything else surfaces. Present in
the MapLibre bundled by GeoLibre v1.9.0 and still present in 5.24.0, so
upgrading the host does not clear it, and nothing in this repository causes it.

## Licence

MIT.
