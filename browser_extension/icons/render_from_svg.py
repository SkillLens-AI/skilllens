"""Render the tetrahedron favicon.svg into PNG icons (16/32/48/128).

The SVG is three polygons with vertical linear gradients. We draw each face
by building a polygon mask + a gradient image and compositing onto a
transparent canvas at 4x the target size, then downsample for clean edges.
"""
from PIL import Image, ImageDraw

# SVG viewBox is 0..100; gradients are vertical (x1=0,y1=0 -> x2=0,y2=1).
FACES = [
    # (polygon points, [(offset%, hex)], label)
    ([(50, 8), (12, 75), (30, 62), (50, 28)],
     [(0, "#F0E5CC"), (55, "#C8B697"), (100, "#8A7A5A")],
     "left"),
    ([(50, 8), (88, 75), (70, 62), (50, 28)],
     [(0, "#BBA989"), (100, "#5C4F35")],
     "right"),
    ([(12, 75), (88, 75), (70, 62), (30, 62)],
     [(0, "#75684A"), (100, "#1F1810")],
     "bottom"),
]


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def interp(stops, t):
    """Interpolate (offset%, hex) gradient at t in [0, 1]."""
    t = max(0.0, min(1.0, t))
    pct = t * 100
    for i in range(1, len(stops)):
        if pct <= stops[i][0]:
            o0, c0 = stops[i - 1]
            o1, c1 = stops[i]
            r0, g0, b0 = hex_to_rgb(c0)
            r1, g1, b1 = hex_to_rgb(c1)
            span = max(0.0001, o1 - o0)
            local = (pct - o0) / span
            return (
                int(r0 + (r1 - r0) * local),
                int(g0 + (g1 - g0) * local),
                int(b0 + (b1 - b0) * local),
            )
    return hex_to_rgb(stops[-1][1])


def render_face(canvas, scale, polygon, stops):
    """Composite one gradient-filled polygon onto canvas."""
    w, h = canvas.size

    # Polygon bounding box in canvas coords (used to drive vertical gradient).
    scaled_poly = [(x * scale, y * scale) for x, y in polygon]
    ys = [p[1] for p in scaled_poly]
    top, bot = min(ys), max(ys)
    height_px = max(1, int(bot - top) + 1)

    # Build a 1-pixel-wide vertical gradient column.
    gradient = Image.new("RGBA", (1, height_px))
    gpx = gradient.load()
    for row in range(height_px):
        t = row / max(1, height_px - 1)
        gpx[0, row] = (*interp(stops, t), 255)

    # Stretch the gradient column to fit the bounding box of the polygon
    # so when we mask, each row in the polygon picks up the right colour.
    bbox_w = max(1, int(max(p[0] for p in scaled_poly) - min(p[0] for p in scaled_poly)) + 1)
    bbox_left = int(min(p[0] for p in scaled_poly))
    grad_full = gradient.resize((bbox_w, height_px), Image.NEAREST)

    # Polygon mask on a same-size scratch image.
    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).polygon(scaled_poly, fill=255)

    # Paste the gradient block, masked by the polygon mask.
    grad_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    grad_layer.paste(grad_full, (bbox_left, int(top)))
    canvas.alpha_composite(Image.composite(grad_layer, Image.new("RGBA", canvas.size, (0, 0, 0, 0)), mask))


def render(size):
    """Render the icon at the requested logical size."""
    supersample = 4
    big = Image.new("RGBA", (size * supersample, size * supersample), (0, 0, 0, 0))
    scale = (size * supersample) / 100.0
    for polygon, stops, _label in FACES:
        render_face(big, scale, polygon, stops)
    return big.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    out_dir = os.path.dirname(os.path.abspath(__file__))
    for sz in (16, 32, 48, 128):
        img = render(sz)
        path = os.path.join(out_dir, f"icon_{sz}.png")
        img.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({sz}x{sz})")
