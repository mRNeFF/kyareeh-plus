#!/usr/bin/env python
"""Kyareeh+ — visuels de la fiche Chrome Web Store (Pillow).

Génère, à partir de l'icône du dépôt et des captures de scripts/store-shots.mjs :
  - promo-440x280.png   petite vignette promotionnelle
  - promo-1400x560.png  bannière (marquee)
  - icon-128.png        copie de l'icône du manifeste (128 x 128)

Usage :
  python scripts/store-promo.py [dossier_sortie]
  (par défaut : ../_shots/store)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "_shots" / "store"

ACCENT = (255, 77, 46)
ACCENT_SOFT = (255, 138, 109)
TEXT = (244, 245, 248)
MUTED = (160, 167, 180)
DARK_TOP = (22, 24, 32)
DARK_BOTTOM = (7, 8, 11)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_SEMI = "C:/Windows/Fonts/segoeuisl.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def background(width: int, height: int) -> Image.Image:
    """Dégradé vertical sombre + halo orange en haut à gauche."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(round(DARK_TOP[i] + (DARK_BOTTOM[i] - DARK_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)

    glow = Image.new("RGB", (width, height), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    radius = int(min(width, height) * 0.85)
    gd.ellipse(
        (-radius // 2, -radius, radius, radius),
        fill=(120, 30, 12),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 3))
    img = Image.blend(img, Image.blend(img, glow, 0.55), 0.65)

    # Liseré supérieur très discret.
    d = ImageDraw.Draw(img)
    d.line([(0, 0), (width, 0)], fill=(38, 41, 52))
    return img


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def paste_with_shadow(canvas: Image.Image, card: Image.Image, xy: tuple[int, int], blur: int = 28, offset: int = 18) -> None:
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    alpha = card.getchannel("A").point(lambda v: int(v * 0.55))
    shadow.paste((0, 0, 0, 255), (xy[0], xy[1] + offset), alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(card, xy)


def pill(draw: ImageDraw.ImageDraw, xy: tuple[int, int], label: str, f: ImageFont.FreeTypeFont) -> None:
    x, y = xy
    box = draw.textbbox((0, 0), label, font=f)
    w = box[2] - box[0] + 26
    h = box[3] - box[1] + 14
    draw.rounded_rectangle([x, y, x + w, y + h], h // 2, fill=(46, 20, 16), outline=(120, 46, 34))
    draw.text((x + 13, y + h // 2), label, font=f, fill=ACCENT_SOFT, anchor="lm")


def small_tile(icon: Image.Image) -> Image.Image:
    w, h = 440, 280
    canvas = background(w, h).convert("RGBA")

    icon_small = icon.resize((76, 76), Image.LANCZOS)
    canvas.alpha_composite(icon_small, (28, 34))

    draw = ImageDraw.Draw(canvas)
    draw.text((120, 34), "Kyareeh+", font=font(FONT_BOLD, 34), fill=TEXT)
    draw.text((122, 82), "Tableau de bord &", font=font(FONT_REG, 17), fill=MUTED)
    draw.text((122, 102), "duels entre cartes", font=font(FONT_REG, 17), fill=MUTED)

    draw.line([(28, 150), (412, 150)], fill=(41, 44, 55))
    draw.text((28, 170), "Valorisation en chakra · %Drop", font=font(FONT_REG, 15), fill=(214, 218, 226))
    draw.text((28, 192), "Marché · statistiques · duels", font=font(FONT_REG, 15), fill=(214, 218, 226))

    pill(draw, (28, 226), "kyara.games", font(FONT_SEMI, 14))
    draw.text((412, 233), "Chrome · Edge · Firefox", font=font(FONT_REG, 12), fill=(120, 127, 140), anchor="ra")
    return canvas.convert("RGB")


def marquee(icon: Image.Image, panel: Image.Image) -> Image.Image:
    w, h = 1400, 560
    canvas = background(w, h).convert("RGBA")

    icon_big = icon.resize((104, 104), Image.LANCZOS)
    canvas.alpha_composite(icon_big, (64, 58))

    draw = ImageDraw.Draw(canvas)
    draw.text((188, 62), "Kyareeh+", font=font(FONT_BOLD, 62), fill=TEXT)
    draw.text((190, 146), "Tableau de bord, valorisation en chakra", font=font(FONT_REG, 24), fill=(206, 211, 221))
    draw.text((190, 180), "et duels entre cartes", font=font(FONT_REG, 24), fill=(206, 211, 221))

    features = [
        ("Valeur du compte", "médianes du marché, fourchette basse/haute"),
        ("Duels entre cartes", "deck de Mythiques, entraînement ou salon en ligne"),
        ("Analyse", "%Drop par booster, marché, statistiques"),
    ]
    y = 246
    for title, detail in features:
        draw.ellipse([190, y + 6, 198, y + 14], fill=ACCENT)
        draw.text((214, y - 2), title, font=font(FONT_SEMI, 19), fill=TEXT)
        draw.text((214, y + 24), detail, font=font(FONT_REG, 15), fill=MUTED)
        y += 66

    pill(draw, (190, 468), "kyara.games", font(FONT_SEMI, 16))
    draw.text((66, 512), "Extension Chrome, Edge et Firefox — non affiliée à Kyara.",
              font=font(FONT_REG, 14), fill=(120, 127, 140))

    # Panneau : hauteur 440 px, largeur proportionnelle (bornée).
    target_h = 440
    scale = min(target_h / panel.height, 690 / panel.width)
    card = panel.resize((round(panel.width * scale), round(panel.height * scale)), Image.LANCZOS)
    card = rounded(card, 20)
    framed = Image.new("RGBA", (card.width + 2, card.height + 2), (0, 0, 0, 0))
    ImageDraw.Draw(framed).rounded_rectangle(
        [0, 0, framed.width - 1, framed.height - 1], 21, outline=(58, 62, 76), width=2
    )
    framed.alpha_composite(card, (1, 1))
    card = framed
    x = w - card.width - 64
    paste_with_shadow(canvas, card, (x, 52))
    return canvas.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # L'icône 128 du paquet suit la règle Chrome (illustration 96 + 16 px de marge
    # transparente) : pour les visuels, on repart de l'illustration pleine (96 px).
    artwork = Image.open(ROOT / "icons" / "icon-96.png").convert("RGBA")
    store_icon = Image.open(ROOT / "icons" / "icon-128.png").convert("RGBA")
    panel = Image.open(OUT / "panel-2-duel.png").convert("RGBA")

    store_icon.save(OUT / "icon-128.png")
    small_tile(artwork).save(OUT / "promo-440x280.png")
    marquee(artwork, panel).save(OUT / "promo-1400x560.png")

    for name in ("icon-128.png", "promo-440x280.png", "promo-1400x560.png"):
        img = Image.open(OUT / name)
        print(f"OK {name:22s} {img.size[0]} x {img.size[1]}")


if __name__ == "__main__":
    main()
