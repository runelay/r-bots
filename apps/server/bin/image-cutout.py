import argparse
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
from scipy import ndimage

MODELS = {
    "birefnet-general-lite": {"mean": (0.485, 0.456, 0.406), "std": (0.229, 0.224, 0.225), "sigmoid": True},
    "isnet-general-use": {"mean": (0.5, 0.5, 0.5), "std": (1.0, 1.0, 1.0), "sigmoid": False},
}
SIZE = 1024


def model_path(name):
    root = os.environ.get("IMAGE_CUTOUT_MODELS", "/opt/rbots-tools/cutout/current/models")
    path = os.path.join(root, f"{name}.onnx")
    if not os.path.isfile(path):
        raise SystemExit(f"modelo {name} não encontrado em {root}")
    return path


def border_color(rgb):
    h, w, _ = rgb.shape
    band = max(2, round(min(h, w) * 0.02))
    frame = np.concatenate(
        [rgb[:band].reshape(-1, 3), rgb[-band:].reshape(-1, 3), rgb[:, :band].reshape(-1, 3), rgb[:, -band:].reshape(-1, 3)]
    )
    return np.median(frame, axis=0)


def flatten(image):
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    alpha = rgba[..., 3]
    if alpha.min() > 0.99:
        rgb = rgba[..., :3]
        return rgb, border_color(rgb), None
    solid = ndimage.binary_erosion(alpha > 0.98, iterations=2)
    core = rgba[..., :3][solid] if solid.any() else rgba[..., :3][alpha > 0.5]
    candidates = np.array([[0.93, 0.93, 0.93], [0.08, 0.08, 0.08], [0.0, 0.69, 0.25], [1.0, 0.0, 1.0]], dtype=np.float32)
    if core.size:
        sample = core[:: max(1, len(core) // 20000)]
        distance = np.abs(sample[:, None, :] - candidates[None]).sum(-1)
        background = candidates[int(np.argmax(np.percentile(distance, 0.5, axis=0)))]
    else:
        background = candidates[0]
    hint = ndimage.gaussian_filter(ndimage.binary_erosion(alpha > 0.5, iterations=1).astype(np.float32), 1.0)
    rgb = rgba[..., :3] * hint[..., None] + background * (1 - hint[..., None])
    return rgb, background, alpha


def predict(rgb, name):
    spec = MODELS[name]
    session = ort.InferenceSession(model_path(name), providers=["CPUExecutionProvider"])
    small = Image.fromarray((rgb * 255).round().astype(np.uint8)).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    array = np.asarray(small, dtype=np.float32) / 255.0
    array = array / max(float(array.max()), 1e-6)
    array = (array - np.array(spec["mean"], dtype=np.float32)) / np.array(spec["std"], dtype=np.float32)
    tensor = array.transpose(2, 0, 1)[None].astype(np.float32)
    out = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
    if spec["sigmoid"]:
        out = 1.0 / (1.0 + np.exp(-out))
    low, high = float(out.min()), float(out.max())
    out = (out - low) / max(high - low, 1e-6)
    mask = Image.fromarray(out.astype(np.float32), mode="F").resize(
        (rgb.shape[1], rgb.shape[0]), Image.Resampling.BICUBIC
    )
    return np.clip(np.asarray(mask, dtype=np.float32), 0.0, 1.0)


def constrain(alpha, hint):
    inside = ndimage.binary_erosion(hint > 0.5, iterations=4)
    reach = ndimage.binary_dilation(hint > 0.05, iterations=3)
    return np.where(inside, 1.0, np.where(reach, alpha, 0.0))


def refine(alpha, min_fraction):
    alpha = np.where(alpha < 0.03, 0.0, np.where(alpha > 0.97, 1.0, alpha))
    min_area = max(16, int(alpha.size * min_fraction))
    labels, count = ndimage.label(alpha > 0.0, structure=np.ones((3, 3)))
    if count:
        core = ndimage.sum(alpha > 0.5, labels, index=np.arange(1, count + 1))
        keep = np.concatenate([[False], core >= min_area])
        alpha = alpha * keep[labels]
    holes, count = ndimage.label(alpha < 0.5, structure=np.ones((3, 3)))
    if count:
        sizes = ndimage.sum(np.ones_like(alpha), holes, index=np.arange(1, count + 1))
        touching = np.unique(np.concatenate([holes[0], holes[-1], holes[:, 0], holes[:, -1]]))
        small = np.concatenate([[False], sizes < max(4, alpha.size * 0.00002)])
        small[touching] = False
        alpha = np.where(small[holes], 1.0, alpha)
    clear = ndimage.distance_transform_edt(alpha >= 0.1)
    alpha = np.where((alpha >= 0.5) & (clear > 6), 1.0, alpha)
    alpha = ndimage.grey_erosion(alpha, size=(3, 3))
    alpha = ndimage.gaussian_filter(alpha, 0.8)
    return np.where(alpha < 0.02, 0.0, np.where(alpha > 0.985, 1.0, alpha))


def decontaminate(rgb, alpha, background):
    solid = alpha > 0.95
    if not solid.any():
        return rgb
    weight = solid.astype(np.float32)
    spread = rgb * weight[..., None]
    total = weight.copy()
    for sigma in (2, 4, 8, 16):
        blurred = np.stack([ndimage.gaussian_filter(spread[..., c], sigma) for c in range(3)], -1)
        mass = ndimage.gaussian_filter(weight, sigma)
        fill = (total < 1e-3) & (mass > 1e-4)
        spread[fill] = blurred[fill] / mass[fill, None]
        total = np.where(fill, 1.0, total)
    a = alpha[..., None]
    solved = np.clip((rgb - (1 - a) * background) / np.maximum(a, 1e-3), 0.0, 1.0)
    trust = np.clip((a - 0.15) / 0.6, 0.0, 1.0)
    edge = np.where(total[..., None] > 0, spread, solved)
    mixed = trust * solved + (1 - trust) * edge
    return np.where(solid[..., None], rgb, mixed)


def trim(rgba, margin):
    ys, xs = np.nonzero(rgba[..., 3] > 0)
    if ys.size == 0:
        return rgba
    pad = max(4, round(max(rgba.shape[:2]) * margin))
    top, bottom = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + 1 + pad)
    left, right = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + 1 + pad)
    return rgba[top:bottom, left:right]


def stats(rgba):
    alpha = rgba[..., 3]
    partial = (alpha > 0) & (alpha < 255)
    labels, islands = ndimage.label(alpha > 0, structure=np.ones((3, 3)))
    return {
        "width": int(rgba.shape[1]),
        "height": int(rgba.shape[0]),
        "partialEdgePixels": int(partial.sum()),
        "opaquePixels": int((alpha == 255).sum()),
        "islands": int(islands),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--model", default=os.environ.get("IMAGE_CUTOUT_MODEL", "isnet-general-use"))
    parser.add_argument("--trim", action="store_true")
    parser.add_argument("--margin", type=float, default=0.03)
    parser.add_argument("--min-island", type=float, default=0.001)
    args = parser.parse_args()
    if args.model not in MODELS:
        raise SystemExit(f"modelo desconhecido: {args.model}")
    image = ImageOps.exif_transpose(Image.open(args.input))
    rgb, background, hint = flatten(image)
    alpha = predict(rgb, args.model)
    if hint is not None:
        alpha = constrain(alpha, hint)
    alpha = refine(alpha, args.min_island)
    color = decontaminate(rgb, alpha, np.asarray(background, dtype=np.float32))
    rgba = np.dstack([color, alpha])
    rgba = (np.clip(rgba, 0.0, 1.0) * 255).round().astype(np.uint8)
    rgba[rgba[..., 3] == 0, :3] = 0
    if args.trim:
        rgba = trim(rgba, args.margin)
    Image.fromarray(rgba, mode="RGBA").save(args.output, optimize=True)
    print(json.dumps(stats(rgba)))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
