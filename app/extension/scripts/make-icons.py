# Renders the Flux mark (app/web/public/icon.svg: pastel gradient tile #ff9ad5 -> #8b7cff -> #5ee7ff, white italic
# serif "f") to public/icon/{16,32,48,128}.png. No browser: Pillow, a system italic serif, 8x supersampling.
#   python scripts/make-icons.py
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icon")
FONTS = ["C:/Windows/Fonts/georgiai.ttf", "C:/Windows/Fonts/timesi.ttf", "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf"]
STOPS = [(0.0, (0xff, 0x9a, 0xd5)), (0.5, (0x8b, 0x7c, 0xff)), (1.0, (0x5e, 0xe7, 0xff))]
SS = 8


def lerp(t):
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if t <= b:
            k = (t - a) / (b - a)
            return tuple(round(x + (y - x) * k) for x, y in zip(ca, cb))
    return STOPS[-1][1]


def font():
    for f in FONTS:
        if os.path.exists(f):
            return f
    raise SystemExit("no italic serif font found")


def render(size):
    S = size * SS
    # Diagonal gradient (top-left -> bottom-right), like the SVG's x1=0 y1=0 x2=1 y2=1.
    grad = Image.new("RGB", (S, S))
    px = grad.load()
    lut = [lerp(i / (2 * S - 2)) for i in range(2 * S - 1)]
    for y in range(S):
        for x in range(S):
            px[x, y] = lut[x + y]
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=round(S * 9 / 32), fill=255)
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    # The f: its ink box centred on the tile (a hair left, as the italic leans right), about 64% of the tile tall.
    path = font()
    fs = S
    f = ImageFont.truetype(path, fs)
    l, t, r, b = f.getbbox("f")
    fs = round(fs * (S * 0.64) / (b - t))
    f = ImageFont.truetype(path, fs)
    l, t, r, b = f.getbbox("f")
    cx, cy = S * 0.49, S * 0.5
    # A touch heavier when small (the hairlines of the italic would vanish at 16 px).
    sw = round(S * {16: 0.024, 32: 0.016, 48: 0.011}.get(size, 0.006))
    ImageDraw.Draw(tile).text((cx - (l + r) / 2, cy - (t + b) / 2), "f", font=f, fill=(255, 255, 255, 255), stroke_width=sw, stroke_fill=(255, 255, 255, 255))
    return tile.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for n in (16, 32, 48, 128):
    render(n).save(os.path.join(OUT, f"{n}.png"))
print("icons ->", OUT)
