#!/usr/bin/env python3
"""Generate the Drive-It icon set: ribbon icons, installer branding and the site mark.

Drive-It joins the RST family of Revit add-ins, so its icons follow the family style.
Adapted from (MIT, same owner):
  - splash-it tools/glyph.py, tools/make_icons.py and tools/make_installer_branding.py
    (splash-it commit ad7796d): the tile renderer, the per-size corner radius and glyph
    inset, the light/dark variants and the installer dialog/banner/ico layout;
  - gantt-it tools/make_icons.py (gantt-it commit 26cbc59) and pick-it tools/make_icons.py
    (pick-it commit aac8093): glyph geometry hand-tuned in pixels per ribbon size, so
    the 16 px icon stays crisp instead of being a blurred copy of the 32 px one.

The style: a full-bleed rounded tile with transparent, anti-aliased corners and a flat
single-colour glyph, drawn 8x supersampled and box-filtered down. Light: #4F8EF7 on a
#D9D9D9 tile. Dark (Revit's dark theme): #6FA3FA on a #2A303A tile. No outlines,
gradients or text. Corner radius / glyph inset are 3/3 px at 32 px and 1.5/1 px at 16 px.

The glyph: an agent inside a circle. A ring, and inside it a small robot head with an
antenna and two eyes. The eyes are cut out of the head (drawn in the tile colour), so the
glyph stays a single colour on either tile.

Usage:  uv run --with pillow python tools/make_icons.py [--preview PATH]
Writes: src/DriveIt.Revit/Resources/icons/drive_16.png, drive_16_dark.png,
        drive_32.png, drive_32_dark.png                         (RGBA)
        installer/branding/driveit.ico    16/32/48/256 px      (ARPPRODUCTICON)
        installer/branding/dialog.bmp     493x312, 24-bit BMP  (WixUIDialogBmp)
        installer/branding/banner.bmp     493x58,  24-bit BMP  (WixUIBannerBmp)
        docs/assets/drive-it-mark.svg     the 32 px light icon as SVG
        --preview PATH: a review contact sheet (with the alternate glyphs); not committed
Needs:  Pillow, and a bold sans font (Open Sans / DejaVu Sans / Liberation Sans) for the
        installer wordmark. The outputs are committed; rerun only to change them.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BLUE = (0x4F, 0x8E, 0xF7, 0xFF)
BLUE_ON_DARK = (0x6F, 0xA3, 0xFA, 0xFF)
TILE = (0xD9, 0xD9, 0xD9, 0xFF)
TILE_DARK = (0x2A, 0x30, 0x3A, 0xFF)

NAVY = (0x3B, 0x59, 0x98)  # rst-c installer sidebar / rule colour, as gantt-it and splash-it
WHITE = (0xFF, 0xFF, 0xFF)

SUPERSAMPLE = 8

# variant suffix -> (tile, glyph)
VARIANTS = {
    "": (TILE, BLUE),
    "_dark": (TILE_DARK, BLUE_ON_DARK),
}

# Corner radius and glyph inset in px; other sizes scale the 32 px values. The glyph
# geometry below is in absolute px and its circle sits exactly on the inset (1..15 at
# 16 px, 3..29 at 32 px); tile() takes only the radius from here.
TILE_SPECS = {
    32: (3, 3),
    16: (1.5, 1),
}

# A glyph is a list of shapes in px, drawn in order. The colour key is "g" (glyph) or
# "t" (tile: a cut-out). Shapes:
#   ("ring", cx, cy, outer radius, width)   a ring; its inside is cleared to the tile
#   ("disc", cx, cy, r, key)
#   ("rect", x0, y0, x1, y1, corner radius, key)   x1/y1 end-exclusive
# Each glyph has hand-tuned 32 px and 16 px geometry; 48 and 256 px scale the 32 px one.
GLYPHS: dict[str, dict[int, list[tuple]]] = {
    # The Drive-It mark: a robot head with an antenna, inside a ring. The ring's edges land
    # on whole pixels at the cardinal points (2 px wide at 16 px, 3 px at 32 px).
    "agent": {
        32: [
            ("ring", 16, 16, 13, 3),
            ("disc", 16, 8.5, 2, "g"),  # antenna ball
            ("rect", 15, 9, 17, 13, 0, "g"),  # antenna stem
            ("rect", 9, 13, 23, 23, 3, "g"),  # head
            ("rect", 11.5, 16, 14.5, 20, 1.5, "t"),  # eyes
            ("rect", 17.5, 16, 20.5, 20, 1.5, "t"),
        ],
        16: [
            ("ring", 8, 8, 7, 2),
            ("rect", 7, 4, 9, 6, 0, "g"),  # antenna
            ("rect", 5, 6, 11, 11, 1, "g"),  # head
            ("rect", 6, 7, 7, 9, 0, "t"),  # eyes
            ("rect", 9, 7, 10, 9, 0, "t"),
        ],
    },
    # Alternate B: the circle is a solid disc and the robot head is cut out of it.
    "agent-solid": {
        32: [
            ("disc", 16, 16, 13, "g"),
            ("disc", 16, 8.5, 2, "t"),
            ("rect", 15, 9, 17, 13, 0, "t"),
            ("rect", 9, 13, 23, 23, 3, "t"),
            ("rect", 11.5, 16, 14.5, 20, 1.5, "g"),
            ("rect", 17.5, 16, 20.5, 20, 1.5, "g"),
        ],
        16: [
            ("disc", 8, 8, 7, "g"),
            ("rect", 7, 4, 9, 6, 0, "t"),
            ("rect", 4, 6, 12, 12, 1.5, "t"),
            ("rect", 5, 8, 7, 10, 0, "g"),
            ("rect", 9, 8, 11, 10, 0, "g"),
        ],
    },
    # Alternate C: a thinner ring (1 px at 16 px, 2 px at 32 px) around a bigger head.
    "agent-thin": {
        32: [
            ("ring", 16, 16, 13, 2),
            ("disc", 16, 8.5, 2, "g"),
            ("rect", 15, 9, 17, 13, 0, "g"),
            ("rect", 9, 13, 23, 23, 3, "g"),
            ("rect", 11.5, 16, 14.5, 20, 1.5, "t"),
            ("rect", 17.5, 16, 20.5, 20, 1.5, "t"),
        ],
        16: [
            ("ring", 8, 8, 7, 1),
            ("rect", 7, 4, 9, 6, 0, "g"),
            ("rect", 4, 6, 12, 12, 1.5, "g"),
            ("rect", 5, 8, 7, 10, 0, "t"),
            ("rect", 9, 8, 11, 10, 0, "t"),
        ],
    },
}
MARK = "agent"


def glyph_ops(name: str, size: int) -> list[tuple]:
    """The glyph's shapes for `size` px: hand-tuned at 16 and 32, else the 32 px ones scaled."""
    specs = GLYPHS[name]
    if size in specs:
        return specs[size]
    k = size / 32
    return [(op[0], *(v * k if isinstance(v, (int, float)) else v for v in op[1:])) for op in specs[32]]


def draw_ops(draw: ImageDraw.ImageDraw, ops: list[tuple], s: float, tile_color, glyph_color) -> None:
    color = {"g": glyph_color, "t": tile_color}
    for op in ops:
        kind = op[0]
        if kind == "ring":
            _, cx, cy, r, w = op
            draw.ellipse(((cx - r) * s, (cy - r) * s, (cx + r) * s - 1, (cy + r) * s - 1), fill=glyph_color)
            ri = r - w
            draw.ellipse(((cx - ri) * s, (cy - ri) * s, (cx + ri) * s - 1, (cy + ri) * s - 1), fill=tile_color)
        elif kind == "disc":
            _, cx, cy, r, key = op
            draw.ellipse(((cx - r) * s, (cy - r) * s, (cx + r) * s - 1, (cy + r) * s - 1), fill=color[key])
        elif kind == "rect":
            _, x0, y0, x1, y1, r, key = op
            draw.rounded_rectangle((x0 * s, y0 * s, x1 * s - 1, y1 * s - 1), radius=r * s, fill=color[key])
        else:
            raise ValueError(kind)


def tile(size: int, tile_color=TILE, glyph_color=BLUE, glyph: str = MARK) -> Image.Image:
    """The glyph on a full-bleed rounded tile, `size` px square, RGBA with transparent
    corners. Supersampled and box-filtered down, as the sibling add-ins' icons."""
    radius, _inset = TILE_SPECS.get(size, (3 * size / 32, 3 * size / 32))
    s = SUPERSAMPLE
    big = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    draw.rounded_rectangle((0, 0, size * s - 1, size * s - 1), radius=radius * s, fill=tile_color)
    draw_ops(draw, glyph_ops(glyph, size), s, tile_color, glyph_color)
    return big.reduce(s)


# --- installer branding (after splash-it tools/make_installer_branding.py) ---

FONTS = [
    "/usr/share/fonts/TTF/OpenSans-Bold.ttf",
    "/usr/share/fonts/truetype/open-sans/OpenSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit("no bold sans font found; edit FONTS in tools/make_icons.py")


def dialog(glyph: str = MARK) -> Image.Image:
    img = Image.new("RGB", (493, 312), WHITE)
    draw = ImageDraw.Draw(img)
    side = 165  # same sidebar width as rst-c; WixUI draws its text right of it
    draw.rectangle((0, 0, side - 1, 311), fill=NAVY)

    mark = tile(64, glyph=glyph)
    img.paste(mark, ((side - 64) // 2, 72), mark)

    f = font(26)
    text = "Drive-It"
    x0, y0, x1, _y1 = draw.textbbox((0, 0), text, font=f)
    tx = (side - (x1 - x0)) // 2 - x0
    draw.text((tx, 160 - y0), text, font=f, fill=WHITE)

    draw.rectangle((20, 205, side - 21, 206), fill=WHITE)
    return img


def banner(glyph: str = MARK) -> Image.Image:
    img = Image.new("RGB", (493, 58), WHITE)
    draw = ImageDraw.Draw(img)
    mark = tile(32, glyph=glyph)
    img.paste(mark, (493 - 32 - 16, (56 - 32) // 2), mark)
    draw.rectangle((0, 56, 492, 57), fill=NAVY)
    return img


# --- the site mark ---


def hexcolor(c) -> str:
    return "#{:02X}{:02X}{:02X}".format(*c[:3])


def svg(glyph: str = MARK) -> str:
    """The 32 px light icon as SVG: the same shapes, unrasterised."""
    g, t = hexcolor(BLUE), hexcolor(TILE)
    color = {"g": g, "t": t}
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">',
        '  <title>Drive-It</title>',
        f'  <rect width="32" height="32" rx="3" fill="{t}"/>',
    ]
    for op in GLYPHS[glyph][32]:
        kind = op[0]
        if kind == "ring":
            _, cx, cy, r, w = op
            out.append(f'  <circle cx="{cx}" cy="{cy}" r="{r - w / 2:g}" fill="none" stroke="{g}" stroke-width="{w:g}"/>')
        elif kind == "disc":
            _, cx, cy, r, key = op
            out.append(f'  <circle cx="{cx}" cy="{cy}" r="{r}" fill="{color[key]}"/>')
        elif kind == "rect":
            _, x0, y0, x1, y1, r, key = op
            rx = f' rx="{r:g}"' if r else ""
            out.append(f'  <rect x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" height="{y1 - y0:g}"{rx} fill="{color[key]}"/>')
    out.append("</svg>")
    return "\n".join(out) + "\n"


# --- review sheet ---


def preview(path: Path) -> None:
    """A contact sheet for review: each glyph light and dark at 16/32 px, 1x and 8x, the
    256 px .ico frame; then the installer BMPs for the chosen mark."""
    pad, zoom = 16, 8
    label_f = font(14)
    small_f = font(11)
    rows = list(GLYPHS)
    row_h = 32 * zoom + 2 * pad + 20
    width = pad + 120 + (16 * zoom + pad) * 2 + (32 * zoom + pad) * 2 + 256 + pad + 140
    height = pad + row_h * len(rows) + 312 + 58 + 4 * pad + 20
    sheet = Image.new("RGB", (width, height), (0xF4, 0xF4, 0xF4))
    draw = ImageDraw.Draw(sheet)

    def paste(img: Image.Image, x: int, y: int, scale: int = 1) -> None:
        if scale != 1:
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        sheet.paste(img, (x, y), img)

    y = pad
    for name in rows:
        title = f"{name}{'  (chosen)' if name == MARK else '  (alternate)'}"
        draw.text((pad, y), title, font=label_f, fill=(0, 0, 0))
        top = y + 20
        # 1x previews on light and dark ribbon-like backgrounds.
        x = pad
        draw.rectangle((x, top, x + 110, top + 44), fill=(0xF0, 0xF0, 0xF0), outline=(0xC0, 0xC0, 0xC0))
        paste(tile(16, glyph=name), x + 8, top + 14)
        paste(tile(32, glyph=name), x + 32, top + 6)
        draw.rectangle((x, top + 52, x + 110, top + 96), fill=(0x3B, 0x44, 0x53))
        paste(tile(16, TILE_DARK, BLUE_ON_DARK, name), x + 8, top + 66)
        paste(tile(32, TILE_DARK, BLUE_ON_DARK, name), x + 32, top + 58)
        draw.text((x, top + 102), "1x", font=small_f, fill=(0x60, 0x60, 0x60))
        x += 120
        for size in (16, 32):
            for tc, gc in ((TILE, BLUE), (TILE_DARK, BLUE_ON_DARK)):
                paste(tile(size, tc, gc, name), x, top, zoom)
                x += size * zoom + pad
        draw.text((x, top - 2), "ico 256", font=small_f, fill=(0x60, 0x60, 0x60))
        paste(tile(256, glyph=name), x, top + 12)
        y += row_h

    draw.text((pad, y), f"installer branding ({MARK})", font=label_f, fill=(0, 0, 0))
    y += 20
    sheet.paste(dialog(), (pad, y))
    sheet.paste(banner(), (pad + 493 + pad, y))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, optimize=True)
    print(f"wrote {path}")


ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src" / "DriveIt.Revit" / "Resources" / "icons"
BRANDING = ROOT / "installer" / "branding"
ASSETS = ROOT / "docs" / "assets"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--preview", type=Path, help="also write a review contact sheet here")
    args = parser.parse_args()

    written: list[Path] = []
    ICONS.mkdir(parents=True, exist_ok=True)
    for suffix, (tile_color, glyph_color) in VARIANTS.items():
        for size in (16, 32):
            path = ICONS / f"drive_{size}{suffix}.png"
            tile(size, tile_color, glyph_color).save(path, optimize=True)
            written.append(path)

    BRANDING.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 48, 256]
    icons = [tile(n) for n in sizes]
    icons[-1].save(BRANDING / "driveit.ico", sizes=[(n, n) for n in sizes], append_images=icons[:-1])
    dialog().save(BRANDING / "dialog.bmp")
    banner().save(BRANDING / "banner.bmp")
    written += [BRANDING / "driveit.ico", BRANDING / "dialog.bmp", BRANDING / "banner.bmp"]

    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / "drive-it-mark.svg").write_text(svg(), encoding="utf-8")
    written.append(ASSETS / "drive-it-mark.svg")

    for path in written:
        print(f"wrote {path.relative_to(ROOT)}")
    if args.preview:
        preview(args.preview)


if __name__ == "__main__":
    main()
