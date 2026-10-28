#!/usr/bin/env python3
"""
Generate the AI Chart Predictor icon set (16 / 48 / 128 px).

Pure standard library: the icons are drawn with a tiny software rasteriser and
written as PNG with zlib, so no image libraries or binaries are required.

    python3 tools/generate-icons.py

Output: icons/icon16.png, icons/icon48.png, icons/icon128.png
"""

import os
import struct
import zlib

BLUE = (59, 130, 246)
VIOLET = (139, 92, 246)
WHITE = (245, 248, 255)
CYAN = (56, 189, 248)
GREEN = (34, 197, 94)
RED = (239, 68, 68)

SUPERSAMPLE = 4


def lerp(a, b, t):
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


def inside_round_rect(x, y, radius):
    """True when (x, y) in 0..1 space is inside a rounded square."""
    if x < 0 or x > 1 or y < 0 or y > 1:
        return False
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def fill_rect(pixels, size, x0, y0, x1, y1, color, alpha=255):
    left = max(0, int(round(x0 * size)))
    right = min(size - 1, int(round(x1 * size)))
    top = max(0, int(round(y0 * size)))
    bottom = min(size - 1, int(round(y1 * size)))
    for y in range(top, bottom + 1):
        row = pixels[y]
        for x in range(left, right + 1):
            row[x] = (color[0], color[1], color[2], alpha)


def stroke_rect(pixels, size, x0, y0, x1, y1, thickness, color, alpha=255):
    fill_rect(pixels, size, x0, y0, x1, y0 + thickness, color, alpha)
    fill_rect(pixels, size, x0, y1 - thickness, x1, y1, color, alpha)
    fill_rect(pixels, size, x0, y0, x0 + thickness, y1, color, alpha)
    fill_rect(pixels, size, x1 - thickness, y0, x1, y1, color, alpha)


def render(size):
    """Return `size`x`size` RGBA rows."""
    big = size * SUPERSAMPLE
    pixels = [[(0, 0, 0, 0)] * big for _ in range(big)]

    # Rounded square with a diagonal blue -> violet gradient.
    for y in range(big):
        fy = (y + 0.5) / big
        row = pixels[y]
        for x in range(big):
            fx = (x + 0.5) / big
            if inside_round_rect(fx, fy, 0.235):
                colour = lerp(BLUE, VIOLET, min(1.0, max(0.0, (fx * 0.6 + fy * 0.4))))
                row[x] = (colour[0], colour[1], colour[2], 255)

    body = 0.105
    wick = 0.022

    # Candles (x centre, body top, body bottom, wick top, wick bottom, colour).
    candles = [
        (0.285, 0.500, 0.680, 0.430, 0.760, WHITE),
        (0.470, 0.380, 0.600, 0.310, 0.690, WHITE),
        (0.655, 0.245, 0.470, 0.180, 0.560, None),  # ghost / prediction
    ]

    for centre, top, bottom, w_top, w_bottom, colour in candles:
        if colour is None:
            # Dashed outline for the predicted candle.
            thickness = 0.030
            segment = 0.058
            y = top
            while y < bottom:
                fill_rect(pixels, big, centre - body / 2, y, centre + body / 2, min(y + segment, bottom), CYAN, 255)
                y += segment * 2
            y = w_top
            while y < w_bottom:
                fill_rect(pixels, big, centre - wick / 2, y, centre + wick / 2, min(y + segment, w_bottom), CYAN, 255)
                y += segment * 2
            continue

        fill_rect(pixels, big, centre - wick / 2, w_top, centre + wick / 2, w_bottom, colour, 255)
        fill_rect(pixels, big, centre - body / 2, top, centre + body / 2, bottom, colour, 255)

    # Downsample with a box filter.
    factor = SUPERSAMPLE
    result = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(factor):
                source_row = pixels[y * factor + dy]
                for dx in range(factor):
                    pr, pg, pb, pa = source_row[x * factor + dx]
                    r += pr
                    g += pg
                    b += pb
                    a += pa
            count = factor * factor
            row.append((r // count, g // count, b // count, a // count))
        result.append(row)
    return result


def write_png(path, rows):
    height = len(rows)
    width = len(rows[0])

    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")

    with open(path, "wb") as handle:
        handle.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 48, 128):
        rows = render(size)
        path = os.path.join(out_dir, "icon%d.png" % size)
        write_png(path, rows)
        print("wrote", path)


if __name__ == "__main__":
    main()
