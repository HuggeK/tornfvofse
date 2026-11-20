"""Georeference the scanned SMHI depth charts and export web-map overlays.

The two scans in djupkartor/ have no georeferencing. This script fits each
scan to the lake outline in static/maps/vattenomraden.geojson (union of the
water areas = the lake surface according to Lantmäteriet) and writes a
north-up Web Mercator image that MapLibre can drop onto the map as an
image source with four corner coordinates.

Method
  1. Threshold the scan, close small gaps in the drawn shoreline and flood
     fill from the image border: what is NOT reached is the lake as drawn.
  2. Rasterise the real lake (outer rings only, islands ignored, as in 1.)
     on a Web Mercator grid.
  3. Optimise a transform scan -> mercator that maximises the overlap
     (IoU) of the two masks. Starting point: bounding-box alignment.
  4. Resample the scan onto the mercator grid, turn white paper
     transparent and colour the ink, save as WebP (lossless + alpha).

Usage: python -I tools/georef_depth_charts.py [--debug DIR]
Requires numpy, scipy and Pillow only.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, optimize

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
AREAS = ROOT / "static" / "maps" / "vattenomraden.geojson"
OUT_DIR = ROOT / "static" / "maps" / "djupkartor"

EARTH_RADIUS = 6378137.0

CHARTS = [
    {
        "id": "torn",
        "src": ROOT / "djupkartor" / "Djupkarta 1981 Törn 627100-148506 1-0152_Törn_627100-148506.tif",
        # Crop box in source pixels (left, top, right, bottom) or None.
        "crop": None,
        # Rectangles (source px, after crop) left out of the rendered overlay
        # but still used for the fit. Törngöl is drawn on this sheet too, without
        # depths; the 1988 chart below covers it, so drop it here to avoid two
        # slightly different shorelines on top of each other.
        "exclude": [(1860, 0, 4644, 800)],
        # Source metres per pixel from the 500 m scale bar (initial guess).
        "metres_per_px": 1.41,  # 500 m bar = 355 px
        "title": "Djupkarta Törn (SMHI, ekolodad 1981)",
        "keep_px": 12,
        "out_res": 2.5,
        "ink": (8, 48, 110),
    },
    {
        "id": "torngol",
        "src": ROOT / "djupkartor" / "Djupkarta Törngöl 627326-148250 5-0472_Törngöl_627326-148250.tif",
        # Only the left drawing is the depth chart; the right one is the
        # vegetation/shore chart.
        "crop": (1000, 1200, 2500, 2200),
        "exclude": [],
        "metres_per_px": 0.647,  # 500 m bar = 773 px
        "title": "Djupkarta Törngöl (SMHI, 1988)",
        "keep_px": 25,
        "out_res": 1.2,
        "ink": (8, 48, 110),
    },
]


# --- Projection helpers ------------------------------------------------------

def lnglat_to_merc(lng, lat):
    x = EARTH_RADIUS * np.radians(lng)
    y = EARTH_RADIUS * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return x, y


def merc_to_lnglat(x, y):
    lng = np.degrees(x / EARTH_RADIUS)
    lat = np.degrees(2 * np.arctan(np.exp(y / EARTH_RADIUS)) - np.pi / 2)
    return lng, lat


# --- Masks -------------------------------------------------------------------

def load_scan(chart):
    image = Image.open(chart["src"]).convert("L")
    if chart["crop"]:
        image = image.crop(chart["crop"])
    return np.asarray(image, dtype=np.uint8)


def scan_lake_mask(gray, close_px):
    ink = gray < 128
    ink = ndimage.binary_dilation(ink, iterations=close_px)
    paper = ~ink
    labels, _ = ndimage.label(paper)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside = np.isin(labels, border[border > 0])
    lake = ~outside
    # Undo the dilation so the outline sits on the drawn line again.
    lake = ndimage.binary_erosion(lake, iterations=close_px)
    # Drop specks (text, dots) and keep sizeable blobs only.
    labels, count = ndimage.label(lake)
    if count:
        sizes = ndimage.sum(lake, labels, range(1, count + 1))
        keep = np.isin(labels, 1 + np.flatnonzero(sizes > 0.01 * sizes.max()))
        lake = keep
    return lake


def lake_polygons_merc():
    data = json.loads(AREAS.read_text(encoding="utf-8"))
    rings = []
    for feature in data["features"]:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        for polygon in polygons:
            outer = np.asarray(polygon[0])
            x, y = lnglat_to_merc(outer[:, 0], outer[:, 1])
            rings.append(np.column_stack([x, y]))
    return rings


def rasterise(rings, grid):
    x0, y1, res, width, height = grid
    image = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(image)
    for ring in rings:
        draw.polygon([((x - x0) / res, (y1 - y) / res) for x, y in ring], fill=1)
    return np.asarray(image, dtype=bool)


# --- Fitting -----------------------------------------------------------------

def make_grid(rings, margin, res):
    allpts = np.vstack(rings)
    x0, y0 = allpts.min(axis=0) - margin
    x1, y1 = allpts.max(axis=0) + margin
    width = int(math.ceil((x1 - x0) / res))
    height = int(math.ceil((y1 - y0) / res))
    return (x0, y1, res, width, height)


def grid_xy(grid):
    x0, y1, res, width, height = grid
    cols, rows = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    return x0 + cols * res, y1 - rows * res


def params_to_matrix(p):
    """p = [a, b, c, d, e, f]: x = a*col + b*row + c ; y = d*col + e*row + f."""
    return np.array([[p[0], p[1], p[2]], [p[3], p[4], p[5]], [0, 0, 1]])


def similarity_to_params(scale, angle, tx, ty):
    # Rows grow downwards, mercator y grows upwards -> flip y.
    c, s = scale * math.cos(angle), scale * math.sin(angle)
    return [c, s, tx, s, -c, ty]


def warp_mask_to_grid(mask_small, step, matrix, grid):
    """Sample a (downsampled) scan mask on the mercator grid."""
    gx, gy = grid_xy(grid)
    inv = np.linalg.inv(matrix)
    col = inv[0, 0] * gx + inv[0, 1] * gy + inv[0, 2]
    row = inv[1, 0] * gx + inv[1, 1] * gy + inv[1, 2]
    return ndimage.map_coordinates(mask_small, [row / step - 0.5, col / step - 0.5], order=1, cval=0.0)


def soft_iou(a, b):
    inter = np.minimum(a, b).sum()
    union = np.maximum(a, b).sum()
    return inter / union if union else 0.0


def prepare(scan_mask, rings, target_rings, margin, res, step):
    grid = make_grid(target_rings, margin, res)
    target = ndimage.gaussian_filter(rasterise(rings, grid).astype(np.float32), 1.0)
    mask_small = ndimage.zoom(scan_mask.astype(np.float32), 1 / step, order=1)
    mask_small = ndimage.gaussian_filter(mask_small, 1.0)
    return grid, target, mask_small


def fit(scan_mask, rings, target_rings, init, margin, levels):
    """Coarse-to-fine: similarity at the first level, affine on every level.

    levels = [(grid resolution in mercator metres, scan downsampling step)]
    """
    def iou_for(matrix, level):
        grid, target, mask_small, step = level
        return soft_iou(warp_mask_to_grid(mask_small, step, matrix, grid), target)

    prepared = [prepare(scan_mask, rings, target_rings, margin, res, step) + (step,)
                for res, step in levels]

    best = optimize.minimize(
        lambda q: -iou_for(params_to_matrix(similarity_to_params(*q)), prepared[0]),
        init, method="Powell", options={"xtol": 1e-4, "ftol": 1e-6, "maxfev": 3000})
    sim = best.x
    print(f"  similarity IoU {-best.fun:.3f} scale {sim[0]:.3f} merc-m/px angle {math.degrees(sim[1]):.2f} deg", flush=True)

    params = np.array(similarity_to_params(*sim))
    for level, (res, _) in zip(prepared, levels):
        p0 = params.copy()
        unit = np.array([sim[0], sim[0], res * 5, sim[0], sim[0], res * 5]) * 0.05

        result = optimize.minimize(
            lambda z: -iou_for(params_to_matrix(p0 + z * unit), level),
            np.zeros(6), method="Powell", options={"xtol": 1e-3, "ftol": 1e-6, "maxfev": 3000})
        params = p0 + result.x * unit
        print(f"  affine @ {res} m IoU {-result.fun:.4f}", flush=True)
    return params_to_matrix(params), prepared[-1]


def initial_similarity(scan_mask, rings, metres_per_px):
    rows, cols = np.nonzero(scan_mask)
    allpts = np.vstack(rings)
    (tx0, ty0), (tx1, ty1) = allpts.min(axis=0), allpts.max(axis=0)
    # Centre on the scan's lake centroid instead of its bounding box, which
    # inlet/outlet streams would skew.
    rows, cols = np.array([rows.mean()] * 2), np.array([cols.mean()] * 2)
    if metres_per_px is None:
        raise ValueError("metres_per_px is required")
    # Mercator metres are stretched by 1/cos(lat) compared with ground metres.
    lat = math.radians(56.56)
    scale = metres_per_px / math.cos(lat)
    cx, cy = (tx0 + tx1) / 2, (ty0 + ty1) / 2
    ccol, crow = cols[0], rows[0]
    return [scale, 0.0, cx - scale * ccol, cy + scale * crow]


# --- Rendering ---------------------------------------------------------------

MAX_TEXTURE = 4096  # safe WebGL texture size on phones


def render(chart, gray, lake, matrix, margin):
    """Resample the scan onto a north-up mercator grid; paper -> transparent."""
    # Keep ink near the lake only: drops title, notes and sheet edges.
    keep = ndimage.binary_dilation(lake, iterations=chart["keep_px"])
    for left, top, right, bottom in chart["exclude"]:
        keep[top:bottom, left:right] = False

    rows, cols = np.nonzero(keep)
    corners = np.array([[cols.min(), rows.min(), 1], [cols.max(), rows.min(), 1],
                        [cols.max(), rows.max(), 1], [cols.min(), rows.max(), 1]], float)
    merc = corners @ matrix[:2].T
    x0, y0 = merc.min(axis=0) - margin
    x1, y1 = merc.max(axis=0) + margin

    res = chart["out_res"]
    res = max(res, (x1 - x0) / MAX_TEXTURE, (y1 - y0) / MAX_TEXTURE)
    width = int(math.ceil((x1 - x0) / res))
    height = int(math.ceil((y1 - y0) / res))
    grid = (x0, y1, res, width, height)

    gx, gy = grid_xy(grid)
    inv = np.linalg.inv(matrix)
    col = inv[0, 0] * gx + inv[0, 1] * gy + inv[0, 2]
    row = inv[1, 0] * gx + inv[1, 1] * gy + inv[1, 2]
    del gx, gy

    # Antialias when shrinking: pre-blur the scan by the shrink factor.
    shrink = res / math.sqrt(abs(np.linalg.det(matrix[:2, :2])))
    ink = (255.0 - gray.astype(np.float32)) / 255.0
    if shrink > 1.2:
        ink = ndimage.gaussian_filter(ink, sigma=0.4 * shrink)
    ink_out = ndimage.map_coordinates(ink, [row, col], order=1, cval=0.0)
    keep_out = ndimage.map_coordinates(keep.astype(np.float32), [row, col], order=1, cval=0.0)

    # Contrast stretch: thin pen lines get faint after resampling.
    alpha = np.clip((ink_out - 0.12) / 0.35, 0, 1) * np.clip(keep_out, 0, 1)
    rgba = np.zeros((height, width, 4), np.uint8)
    rgba[..., :3] = chart["ink"]
    rgba[..., 3] = (alpha * 255).round().astype(np.uint8)
    image = Image.fromarray(rgba, "RGBA")

    west, north = merc_to_lnglat(x0, y1)
    east, south = merc_to_lnglat(x1, y0)
    coordinates = [[west, north], [east, north], [east, south], [west, south]]
    return image, [[round(float(v), 7) for v in c] for c in coordinates], res


def ground_metres_per_px(matrix, lat):
    return math.sqrt(abs(np.linalg.det(matrix[:2, :2]))) * math.cos(math.radians(lat))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", type=Path, help="write fit previews and fitted matrices here")
    parser.add_argument("--reuse", action="store_true", help="reuse matrices from --debug instead of fitting")
    args = parser.parse_args()

    rings = lake_polygons_merc()
    # Törngöl: a window around the small lake; the fit only looks inside it.
    (wx0, wx1), (wy0, wy1) = lnglat_to_merc(np.array([15.5195, 15.534]), np.array([56.5855, 56.5925]))
    torngol_rings = [np.array([[wx0, wy0], [wx1, wy1]])]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    for chart in CHARTS:
        gray = load_scan(chart)
        lake = scan_lake_mask(gray, close_px=4)
        is_torn = chart["id"] == "torn"
        print(chart["id"], flush=True)
        cache = args.debug / f"matrix_{chart['id']}.npy" if args.debug else None
        if args.reuse and cache and cache.exists():
            matrix = np.load(cache)
        else:
            target_rings = rings if is_torn else torngol_rings
            init = initial_similarity(lake, target_rings, chart["metres_per_px"])
            levels = [(40, 16), (12, 4)] if is_torn else [(12, 4), (4, 2)]
            matrix, (grid, target_soft, _, step) = fit(lake, rings, target_rings, init,
                                                       margin=300 if is_torn else 100, levels=levels)
            if args.debug:
                target = target_soft > 0.5
                mask_small = ndimage.zoom(lake.astype(np.float32), 1 / step, order=1)
                warped = warp_mask_to_grid(mask_small, step, matrix, grid) > 0.5
                rgb = np.full(target.shape + (3,), 255, np.uint8)
                rgb[target & ~warped] = (220, 60, 60)    # only real lake
                rgb[warped & ~target] = (60, 60, 220)    # only scan
                rgb[warped & target] = (180, 180, 180)   # both
                Image.fromarray(rgb).save(args.debug / f"fit_{chart['id']}.png")
                np.save(cache, matrix)

        image, coordinates, res = render(chart, gray, lake, matrix, margin=60)
        out = OUT_DIR / f"{chart['id']}.webp"
        image.save(out, "WEBP", lossless=True, quality=100, method=6)
        print(f"  {out.name} {image.size[0]}x{image.size[1]} {out.stat().st_size // 1024} kB, "
              f"scan {ground_metres_per_px(matrix, 56.56):.2f} m/px, output {res:.2f} merc-m/px", flush=True)
        manifest.append({"id": chart["id"], "title": chart["title"], "url": f"/maps/djupkartor/{out.name}",
                         "coordinates": coordinates})

    (OUT_DIR / "djupkartor.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
