#!/usr/bin/env python3
"""Genererar app-ikoner för "Antonias dagbok <3" utan externa beroenden.

Ritar en rundad kvadrat i dusty rose med ett mjukt gräddvitt hjärta i mitten
och skriver ut PNG-filer i tre storlekar (180/192/512) till ./icons.

Pure stdlib: vi bygger PNG-binären själva med zlib + struct (Pillow saknas).
Kör en gång: `python3 gen_icons.py`. Ikonerna checkas in i repot.
"""

import math
import struct
import zlib
import os

# --- Palett (samma som appens "Dimrosa & grädde") ---
ACCENT = (0xC6, 0x8A, 0x95)   # dusty rose – ikonbakgrund
CREAM = (0xFA, 0xF4, 0xF2)    # gräddvit – hjärtat
BG = (0xFA, 0xF4, 0xF2)       # hörnen utanför den rundade kvadraten

ICONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
SIZES = (180, 192, 512)


def heart_contains(nx, ny):
    """True om den normaliserade punkten (nx, ny) ligger inuti ett hjärta.

    nx, ny går från -1..1 med origo i mitten. Vi använder den klassiska
    hjärt-implicit-ekvationen (x^2 + y^2 - 1)^3 - x^2*y^3 <= 0.
    """
    x = nx * 1.25                # bredda lite så hjärtat fyller ytan
    y = -ny * 1.25               # vänd y (skärm-y pekar nedåt)
    a = x * x + y * y - 1.0
    return a * a * a - x * x * y * y * y <= 0.0


def make_pixels(size):
    """Returnerar en rad-för-rad bytes-buffert (RGB) för en ikon i given storlek."""
    radius = size * 0.22         # hörnradie på den rundade kvadraten
    # Hjärtats ruta: centrerad, ca 62% av ikonen
    heart_box = size * 0.62
    cx = size / 2.0
    cy = size / 2.0

    rows = bytearray()
    for py in range(size):
        rows.append(0)           # PNG filter-byte (0 = None) per rad
        for px in range(size):
            # Avstånd in mot rundade hörn → avgör om vi är på "plattan"
            on_plate = _inside_rounded_square(px, py, size, radius)
            if not on_plate:
                rows += bytes(BG)
                continue

            # Är pixeln inuti hjärtat?
            nx = (px + 0.5 - cx) / (heart_box / 2.0)
            ny = (py + 0.5 - cy) / (heart_box / 2.0)
            if abs(nx) <= 1.4 and abs(ny) <= 1.4 and heart_contains(nx, ny):
                rows += bytes(CREAM)
            else:
                rows += bytes(ACCENT)
    return bytes(rows)


def _inside_rounded_square(px, py, size, radius):
    """True om pixeln ligger innanför en rundad kvadrat som fyller hela ikonen."""
    x, y = px + 0.5, py + 0.5
    # Närmaste avstånd till en kant; hörnen kapas av radien
    dx = max(radius - x, x - (size - radius), 0.0)
    dy = max(radius - y, y - (size - radius), 0.0)
    return dx * dx + dy * dy <= radius * radius


def write_png(path, size, rgb_rows):
    """Skriver en minimal PNG (8-bit RGB) till path."""
    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit, color type 2 (RGB)
    idat = zlib.compress(rgb_rows, 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    for size in SIZES:
        pixels = make_pixels(size)
        path = os.path.join(ICONS_DIR, f"icon-{size}.png")
        write_png(path, size, pixels)
        print(f"skrev {path}")


if __name__ == "__main__":
    main()
