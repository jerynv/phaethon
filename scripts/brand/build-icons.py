#!/usr/bin/env python3
"""Builds Phaethon's app icons and README banners from build/brand/mark.png.

    python3 -I scripts/brand/build-icons.py

Writes:
  build/icon.icon/          Icon Composer bundle (macOS 26+; electron-builder compiles it with actool)
  build/icon.png, .icns, .ico   the same tile on Apple's 1024 grid, for Linux, Windows and older macOS
  docs/brand/banner-light.png, banner-dark.png   README banners
Needs Pillow 10+.
"""
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MARK = ROOT / "build/brand/mark.png"
FONT = ROOT / "node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2"
COBALT = (54, 88, 212)
COBALT_LIGHT = (122, 146, 255)  # the mark on dark backgrounds


def glyph() -> Image.Image:
    """The mark cropped to its ink."""
    im = Image.open(MARK).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())


def recolor(im: Image.Image, rgb) -> Image.Image:
    out = Image.new("RGBA", im.size, rgb + (0,))
    out.putalpha(im.getchannel("A"))
    return out


def place(canvas: Image.Image, mark: Image.Image, height: int, center) -> None:
    w = round(mark.width * height / mark.height)
    m = mark.resize((w, height), Image.LANCZOS)
    canvas.alpha_composite(m, (round(center[0] - w / 2), round(center[1] - height / 2)))


def squircle_mask(size: int, n: float = 5.0, ss: int = 4) -> Image.Image:
    """A superellipse |x|^n + |y|^n = 1, close to Apple's continuous-corner icon shape."""
    big = size * ss
    r = big / 2
    pts = []
    steps = 720
    import math

    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / n), c)
        y = r + r * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def vertical_gradient(size, top, bottom) -> Image.Image:
    w, h = size
    g = Image.new("RGBA", size)
    px = g.load()
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(w):
            px[x, y] = c
    return g


def tile(size: int = 1024) -> Image.Image:
    """Apple's macOS icon grid: an 824 body inside 1024, with its drop shadow."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body = round(size * 824 / 1024)
    off = (size - body) // 2
    mask = squircle_mask(body)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = Image.new("RGBA", (body, body), (16, 24, 64, 90))
    sh.putalpha(mask.point(lambda a: a * 90 // 255))
    shadow.alpha_composite(sh, (off, off + round(size * 10 / 1024)))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 14 / 1024)))

    face = vertical_gradient((body, body), (255, 255, 255), (238, 242, 253))
    place(face, glyph(), round(body * 0.56), (body * 0.5, body * 0.5))
    face.putalpha(mask)
    canvas.alpha_composite(face, (off, off))
    return canvas


def icon_composer(dest: Path) -> None:
    """A light fill with the mark as one layer; macOS adds the shape, glass and shadow."""
    if dest.exists():
        shutil.rmtree(dest)
    (dest / "Assets").mkdir(parents=True)
    layer = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    place(layer, glyph(), round(1024 * 0.56), (512, 512))
    layer.save(dest / "Assets/mark.png")
    spec = {
        "fill": {"linear-gradient": ["extended-srgb:1.00000,1.00000,1.00000,1.00000", "extended-srgb:0.93333,0.94902,0.99216,1.00000"]},
        "groups": [
            {
                "layers": [{"blend-mode": "normal", "fill": "none", "glass": True, "hidden": False, "image-name": "mark.png", "name": "mark"}],
                "shadow": {"kind": "neutral", "opacity": 0.5},
                "translucency": {"enabled": True, "value": 0.5},
            }
        ],
        "supported-platforms": {"squares": ["macOS"]},
    }
    (dest / "icon.json").write_text(json.dumps(spec, indent=2) + "\n")


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT), size)
    f.set_variation_by_axes([weight])
    return f


def banner(dark: bool) -> Image.Image:
    W, H = 2560, 640
    bg_top, bg_bottom = ((13, 17, 33), (9, 12, 24)) if dark else ((248, 250, 255), (238, 242, 253))
    im = vertical_gradient((W, H), bg_top, bg_bottom)

    title = font(176, 700)
    tag = font(56, 400)
    lines = ["A minimal, desktop-first AI workspace", "that teaches you why, not just what."]
    d = ImageDraw.Draw(im)
    text_w = max(d.textlength("Phaethon", font=title), *(d.textlength(l, font=tag) for l in lines))
    icon_size, gap = 440, 100
    left = round((W - (icon_size + gap + text_w)) / 2)
    icon_top = (H - icon_size) // 2

    # A soft cobalt glow behind the icon.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cx, cy = left + icon_size / 2, H / 2
    ImageDraw.Draw(glow).ellipse((cx - 420, cy - 420, cx + 420, cy + 420), fill=COBALT + ((80 if dark else 45),))
    im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(150)))

    icon = tile(1024).resize((icon_size, icon_size), Image.LANCZOS)
    im.alpha_composite(icon, (left, icon_top))

    d = ImageDraw.Draw(im)
    x = left + icon_size + gap
    fg = (244, 246, 252) if dark else (14, 20, 40)
    sub = (170, 180, 205) if dark else (72, 82, 108)
    d.text((x, 196), "Phaethon", font=title, fill=fg)
    d.text((x, 420), lines[0], font=tag, fill=sub)
    d.text((x, 490), lines[1], font=tag, fill=sub)
    return im


def main() -> None:
    build = ROOT / "build"
    icon_composer(build / "icon.icon")
    t = tile(1024)
    t.save(build / "icon.png")
    t.save(build / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    t.save(build / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    docs = ROOT / "docs/brand"
    docs.mkdir(parents=True, exist_ok=True)
    banner(False).convert("RGB").save(docs / "banner-light.png", optimize=True)
    banner(True).convert("RGB").save(docs / "banner-dark.png", optimize=True)
    print("icons and banners written")


if __name__ == "__main__":
    main()
