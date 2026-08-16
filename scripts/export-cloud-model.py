#!/usr/bin/env python3
"""Convert the OmniCloudMask weights to the ONNX files the browser runs.

Run once, when the model version changes. It writes vendor/ocm-v4-regnety.onnx
and vendor/ocm-v4-edgenext.onnx, which are committed, because a deployment that
fetched its own weights at build time could quietly change what the mask does
between two deploys of the same tagged plugin.

    python3 scripts/export-cloud-model.py

Needs torch, timm, segmentation_models_pytorch, onnx, onnxruntime and
safetensors. None of them are runtime dependencies of the plugin; the browser
sees only the .onnx files and onnxruntime-web.

Provenance. Code MIT from DPIRD-DMA/OmniCloudMask, weights MIT from the Hugging
Face repo NickWright/OmniCloudMask, model version 4, two smp.Unet models over
timm encoders taking red, green and B8A and writing four classes: clear, thick
cloud, thin cloud, cloud shadow.

The export is checked against the torch model it came from before it is kept. A
conversion that silently differed would move every class boundary in every
delivered layer, and nothing on screen would look wrong.
"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import segmentation_models_pytorch as smp
import torch
from safetensors.torch import load_file

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / ".cache" / "cloud-model"
CACHE = ROOT / ".cache" / "cloud-weights"

REPO = "https://huggingface.co/NickWright/OmniCloudMask/resolve/main"
MODELS = [
    (
        "ocm-v4-regnety",
        "PM_model_OCM_7.97_R_G_NIR_3_smp_regnety_004.pycls_in1k_PT_state",
        "tu-regnety_004",
    ),
    (
        "ocm-v4-edgenext",
        "PM_model_OCM_7.97_R_G_NIR_3_smp_edgenext_small.usi_in1k_PT_state",
        "tu-edgenext_small",
    ),
]

# The block the analysis reads. The export takes dynamic height and width, so
# this only sets the size parity is measured at.
PATCH = 512

# What counts as agreement. The logits are checked as well as the classes,
# because two runs can agree on every class of one patch while differing enough
# to disagree on the next.
MAX_LOGIT_DIFFERENCE = 1e-3

VENDOR.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)

report = {}
failed = False

for name, stem, encoder in MODELS:
    weights = CACHE / f"{stem}.safetensors"
    if not weights.exists():
        print(f"downloading {stem}.safetensors")
        urllib.request.urlretrieve(f"{REPO}/{stem}.safetensors", weights)

    model = smp.Unet(
        encoder_name=encoder, encoder_weights=None, in_channels=3, classes=4
    )
    missing, unexpected = model.load_state_dict(load_file(weights), strict=False)
    if missing or unexpected:
        sys.exit(
            f"{encoder}: {len(missing)} missing and {len(unexpected)} unexpected "
            "keys. The architecture does not match the weights, so the export "
            "would be a different model wearing the right name."
        )
    model.eval()

    path = VENDOR / f"{name}.onnx"
    sample = torch.randn(1, 3, PATCH, PATCH)
    torch.onnx.export(
        model,
        sample,
        str(path),
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "logits": {0: "batch", 2: "height", 3: "width"},
        },
    )

    # One file, weights included. The exporter writes tensors to a sidecar
    # .onnx.data by default, and onnxruntime-web in a browser is handed bytes
    # rather than a path, so it has nothing to resolve a sidecar against.
    graph = onnx.load(str(path), load_external_data=True)
    for stale in path.parent.glob(f"{path.name}.data"):
        stale.unlink()
    onnx.save(graph, str(path), save_as_external_data=False)

    with torch.no_grad():
        expected = model(sample).numpy()

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    actual = session.run(None, {"input": sample.numpy()})[0]

    difference = float(np.abs(expected - actual).max())
    agreement = float((expected.argmax(axis=1) == actual.argmax(axis=1)).mean() * 100)
    megabytes = round(path.stat().st_size / 1_048_576, 1)

    ok = difference <= MAX_LOGIT_DIFFERENCE and agreement == 100.0
    failed = failed or not ok
    report[name] = {
        "encoder": encoder,
        "weights": f"{stem}.safetensors",
        "megabytes": megabytes,
        "maxLogitDifference": difference,
        "classAgreementPercent": agreement,
        "matchesTorch": ok,
    }
    print(
        f"{name}: {megabytes} MB, max logit difference {difference:.2e}, "
        f"classes agree {agreement:.2f} percent"
    )

(VENDOR / "cloud-model.json").write_text(json.dumps(report, indent=2) + "\n")

if failed:
    sys.exit(
        "\nThe export does not match the torch model it came from. Nothing "
        "downstream should use these files."
    )
print(f"\nWrote {len(MODELS)} model(s) to {VENDOR}")
