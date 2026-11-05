"""Make the 128x128 Marketplace icon from the 3D render in docs/icon_source.png.

Steps: remove the red crosshair, crop tightly around the render, brighten,
and put it on a dark rounded square.
"""
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")

# Bottom-right quadrant of the 1376x1184 screenshot holds the 3D render.
quad = (706, 640, 1242, 1176)
crop = im.crop(quad)

# Remove the red crosshair: replace reddish pixels (and a 1px border) with a median of the surroundings.
a = np.asarray(crop).astype(np.int16)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
red = (r > 35) & (r > g + 20) & (r > b + 20)
mask = Image.fromarray((red * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
median = crop.filter(ImageFilter.MedianFilter(11))
crop = Image.composite(median, crop, mask)

# Auto-crop to the visible render: bounding box of non-dark pixels, made square with a small margin.
lum = np.asarray(crop.convert("L"))
ys, xs = np.nonzero(lum > 40)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
# The render is wider than tall: trim the sides a bit so it fills the square.
side = int(max(y1 - y0, (x1 - x0) * 0.8) * 1.02)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
square = Image.new("RGB", (side, side), (0, 0, 0))
square.paste(crop.crop((max(box[0], 0), max(box[1], 0), min(box[2], crop.width), min(box[3], crop.height))),
             (max(-box[0], 0), max(-box[1], 0)))
crop = square

# Shrink, then brighten and sharpen so it reads at small size.
small = crop.resize((112, 112), Image.LANCZOS)
small = ImageEnhance.Brightness(small).enhance(1.45)
small = ImageEnhance.Contrast(small).enhance(1.25)
small = ImageEnhance.Color(small).enhance(1.3)
small = small.filter(ImageFilter.UnsharpMask(radius=1.2, percent=80, threshold=2))

# Dark rounded square background with transparent corners.
icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
bg = Image.new("RGBA", (128, 128), (18, 20, 24, 255))
round_mask = Image.new("L", (128, 128), 0)
ImageDraw.Draw(round_mask).rounded_rectangle((0, 0, 127, 127), radius=22, fill=255)
icon.paste(bg, (0, 0), round_mask)
icon.paste(small, (8, 8))
icon.save(dst)
print(f"wrote {dst} from {src} box={box}, red pixels removed: {int(red.sum())}")
