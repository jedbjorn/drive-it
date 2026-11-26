# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.1"]
# ///
"""Draw numbered callouts on screenshots for the docs.

Run from the repository root:  uv run tools/annotate-screenshots.py

Each entry below reads a screenshot under docs/ and writes an annotated copy to
docs/images/annotated/. A callout is an outlined box with a numbered badge at a
corner; the doc that shows the image explains each number in a list below it, so
the words stay in the Markdown. Coordinates are pixels of the source image.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images" / "annotated"

ACCENT = (232, 89, 12, 255)  # orange: stands out on the window's light greys and blue buttons
SCALE = 4  # draw the overlay at 4x and scale it down, for smooth edges
BADGE_RADIUS = 13
BOX_WIDTH = 3

# name: (source under docs/, [(x0, y0, x1, y1, badge position), ...]); the badge number is the list position.
SHOTS = {
    "drive-it-window.png": (
        "screenshots/f11-ux/host-home-light-after.png",
        [
            (24, 47, 193, 76, "tl"),  # Staged Actions | Home
            (820, 48, 896, 74, "tr"),  # Settings
            (25, 86, 895, 180, "tl"),  # Workspace root
            (25, 193, 895, 419, "tl"),  # Outside-root requests
            (37, 465, 357, 718, "bl"),  # Run history
            (369, 465, 883, 718, "br"),  # Receipt
            (22, 737, 508, 759, "r"),  # MCP configuration
        ],
    ),
    "staged-actions.png": (
        "screenshots/f11-ux/revit-staged-light-after.png",
        [
            (18, 86, 372, 133, "tr"),  # Name, time, document, outcome
            (25, 168, 875, 198, "tr"),  # One card per document
            (33, 208, 282, 433, "tr"),  # Created, modified, deleted
            (66, 311, 166, 329, "r"),  # Value before and after
            (33, 440, 236, 458, "r"),  # Also touched by Revit
            (18, 480, 425, 757, "tr"),  # Images from the dry run
        ],
    ),
    "settings-drawer.png": (
        "screenshots/f11-ux/drawer-settings-require-light-after.png",
        [
            (17, 56, 364, 212, "tl"),  # Script time limit
            (17, 224, 364, 351, "tl"),  # Require dry run
            (17, 363, 364, 473, "tl"),  # Detect agents
        ],
    ),
}


def annotate(source: Path, callouts: list[tuple[int, int, int, int, str]]) -> Image.Image:
    base = Image.open(source).convert("RGBA")
    overlay = Image.new("RGBA", (base.width * SCALE, base.height * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.load_default(size=15 * SCALE)
    r = BADGE_RADIUS * SCALE
    for number, (x0, y0, x1, y1, corner) in enumerate(callouts, start=1):
        box = [v * SCALE for v in (x0, y0, x1, y1)]
        draw.rounded_rectangle(box, radius=6 * SCALE, outline=ACCENT, width=BOX_WIDTH * SCALE)
        # The badge sits on a corner ("tl", "tr", "bl", "br") or just right of the box ("r"),
        # pulled inside the image when the box touches an edge.
        if corner == "r":
            cx, cy = box[2] + r + 4 * SCALE, (box[1] + box[3]) // 2
        else:
            cx = box[0] if corner[1] == "l" else box[2]
            cy = box[1] if corner[0] == "t" else box[3]
        cx = min(max(cx, r + SCALE), overlay.width - r - SCALE)
        cy = min(max(cy, r + SCALE), overlay.height - r - SCALE)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT, outline=(255, 255, 255, 255), width=2 * SCALE)
        draw.text((cx, cy), str(number), font=font, fill=(255, 255, 255, 255), anchor="mm")
    overlay = overlay.resize(base.size, Image.Resampling.LANCZOS)
    return Image.alpha_composite(base, overlay).convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (source, callouts) in SHOTS.items():
        image = annotate(ROOT / "docs" / source, callouts)
        image.save(OUT / name, optimize=True)
        print(f"docs/images/annotated/{name}  {image.width}x{image.height}  {len(callouts)} callouts")


if __name__ == "__main__":
    main()
