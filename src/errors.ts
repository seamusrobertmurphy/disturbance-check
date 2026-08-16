// Turning a thrown thing into a sentence an operator can act on.
//
// The Earth Engine build needed this to translate OAuth and quota failures.
// Those are gone. What remains are network failures, and they deserve the same
// treatment: a bare "Failed to fetch" tells a verifier nothing about whether
// the problem is theirs, the catalogue's, or a corporate proxy's.

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The run was cancelled.";
  }

  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  // A cross-origin block and a dead network are indistinguishable to fetch, so
  // the message has to cover both without asserting either.
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The imagery catalogue could not be reached. Check the network connection. On a corporate network, earth-search.aws.element84.com and sentinel-cogs.s3.us-west-2.amazonaws.com both need to be reachable over HTTPS.";
  }

  if (/\b429\b|too many requests/i.test(message)) {
    return "The catalogue is rate limiting this connection. Wait a minute and run again.";
  }

  if (/\b5\d\d\b/.test(message)) {
    return `${message} This is a fault at the data provider rather than in the run parameters. Trying again shortly usually clears it.`;
  }

  return message;
}

/**
 * A delivered layer that would not load.
 *
 * Layers held in a bucket under a retention rule stop existing on a schedule,
 * and the failure a client meets is an ordinary 403 or 404. Reporting that as
 * a network fault would send them to their IT department over a delivery that
 * simply reached the end of its life, so the expiry is named where the bundle
 * declares one and the dates agree.
 */
export function describeDeliveryError(
  error: unknown,
  layer: { remote: boolean },
  expiry: { on: string | null; expired: boolean },
): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const gone = /\b40[34]\b|\b410\b|not found|forbidden/i.test(message);

  if (layer.remote && expiry.on && (expiry.expired || gone)) {
    return `These layers expired on ${expiry.on} and are no longer held. The delivery was published with a retention window and the rasters have since been deleted. Ask for a re-run to have them republished; the analysis itself is unaffected.`;
  }

  if (layer.remote && gone) {
    return "The delivered raster is no longer readable at the address the manifest gives. It has either been removed or its permissions changed. The manifest is still readable, so this is a problem with where the rasters are held rather than with the delivery record.";
  }

  return describeError(error);
}
