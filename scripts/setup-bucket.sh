#!/usr/bin/env bash
# Create the Cloud Storage bucket the viewer streams delivered layers from.
#
# Run this once. Earth Engine writes cloud-optimised GeoTIFFs straight into the
# bucket, the viewer reads them by range request, and a lifecycle rule deletes
# them after seven days. Nothing is downloaded and nothing large enters git.
#
# The four properties below are all load-bearing. A bucket missing any one of
# them looks fine from a terminal and fails in a browser:
#
#   public read     the client has no Google account, which is the whole point
#   CORS            without it the browser refuses to read a byte, and the
#                   error surfaces as an opaque network failure
#   range requests  on by default in Cloud Storage; the viewer depends on them
#                   to fetch pyramid tiles instead of whole rasters
#   lifecycle       what makes the seven days real rather than remembered
#
# Usage:
#   scripts/setup-bucket.sh <bucket-name> [origin] [location]
#
# Example:
#   scripts/setup-bucket.sh tuvsud-disturbance-check

set -euo pipefail

BUCKET="${1:?Usage: scripts/setup-bucket.sh <bucket-name> [origin] [location]}"
ORIGIN="${2:-https://seamusrobertmurphy.github.io}"
LOCATION="${3:-US}"
RETENTION_DAYS=7

command -v gcloud >/dev/null || {
  echo "gcloud is not on PATH. Install the Google Cloud CLI first." >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Bucket:    gs://${BUCKET}"
echo "Origin:    ${ORIGIN}"
echo "Location:  ${LOCATION}"
echo "Retention: ${RETENTION_DAYS} days"
echo

# ---------------------------------------------------------------------------
# The bucket itself.
#
# Uniform bucket-level access, because per-object ACLs would let one export
# land private while its siblings are readable, and the viewer would show two
# layers of three with no indication the third was ever meant to exist.

if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "Bucket already exists, updating its policies."
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access
  echo "Created gs://${BUCKET}"
fi

# ---------------------------------------------------------------------------
# Public read.
#
# Anyone may read an object; nobody may list the bucket or write to it.
# objectViewer, not objectAdmin, and never legacyBucketReader.

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member=allUsers \
  --role=roles/storage.objectViewer >/dev/null
echo "Public read granted to allUsers (objectViewer)."

# ---------------------------------------------------------------------------
# CORS.
#
# GET and HEAD only. The exposed response headers are what geotiff.js needs to
# do range reads: without Content-Range and Accept-Ranges it cannot tell a
# partial response from a whole file, and falls back to fetching everything.

cat > "${WORK}/cors.json" <<JSON
[
  {
    "origin": ["${ORIGIN}", "http://localhost:5173"],
    "method": ["GET", "HEAD"],
    "responseHeader": [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag",
      "Date"
    ],
    "maxAgeSeconds": 3600
  }
]
JSON

gcloud storage buckets update "gs://${BUCKET}" --cors-file="${WORK}/cors.json"
echo "CORS set for ${ORIGIN} and the local dev server."

# ---------------------------------------------------------------------------
# Lifecycle.
#
# Age is counted in whole days from the object's creation. Cloud Storage runs
# lifecycle asynchronously and does not promise same-minute deletion, so treat
# seven days as the earliest an object disappears, not the latest. If a layer
# must be gone at a stated hour, delete the prefix explicitly rather than
# trusting this rule to be punctual.

cat > "${WORK}/lifecycle.json" <<JSON
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": ${RETENTION_DAYS} }
    }
  ]
}
JSON

gcloud storage buckets update "gs://${BUCKET}" \
  --lifecycle-file="${WORK}/lifecycle.json"
echo "Lifecycle set: objects deleted after ${RETENTION_DAYS} days."

echo
echo "Done. Grant the Earth Engine service account write access if exports"
echo "fail with a permission error:"
echo
echo "  gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \\"
echo "    --member=user:\$(gcloud config get-value account) \\"
echo "    --role=roles/storage.objectAdmin"
echo
echo "Then run the Earth Engine script, and when its tasks finish:"
echo
echo "  node scripts/prepare-remote-bundle.mjs --bucket ${BUCKET} \\"
echo "    --prefix blackfeet-rp3 --config docs/blackfeet-rp3.config.json"
