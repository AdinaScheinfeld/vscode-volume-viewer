"""Make the 128x128 Marketplace icon from the 3D render in docs/screenshot.png.

Steps: remove the red crosshair, crop tightly around the render, brighten,
and put it on a dark rounded square.
"""
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")

# Tight square around the 3D render (bottom-right quadrant of the 1376x1184 screenshot).
box = (712, 645, 1240, 1173)
crop = im.crop(box)

# Remove the red crosshair: replace reddish pixels (and a 1px border) with a median of the surroundings.
a = np.asarray(crop).astype(np.int16)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
red = (r > 35) & (r > g + 20) & (r > b + 20)
mask = Image.fromarray((red * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
median = crop.filter(ImageFilter.MedianFilter(11))
crop = Image.composite(median, crop, mask)

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
