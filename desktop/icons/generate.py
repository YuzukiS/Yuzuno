#!/usr/bin/env python3
"""Write the desktop app icons from the Yuzuno character (T-179).

The one source is web/src/assets/yuzu-character.png (128x128, see
web/src/assets/README.md). It is not redrawn: icon.png is that file
unchanged, and icon.ico holds it at 128 px with smaller sizes made by
Lanczos downscaling. Nothing larger than the source is made, so there is
no 256 px entry; Windows scales the 128 px image for its largest views.

    python3 desktop/icons/generate.py        # needs Pillow
"""
import hashlib
import shutil
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "web/src/assets/yuzu-character.png"
ICO_SIZES = [16, 24, 32, 48, 64, 128]


def main():
    source = Image.open(SOURCE)
    if source.size != (128, 128) or source.mode != "RGBA":
        raise SystemExit(f"{SOURCE}: expected a 128x128 RGBA image, found {source.size} {source.mode}")
    shutil.copyfile(SOURCE, HERE / "icon.png")
    images = [source if s == 128 else source.resize((s, s), Image.Resampling.LANCZOS) for s in ICO_SIZES]
    # The largest first; the rest are appended as they are, not resized again.
    images[-1].save(HERE / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES],
                    append_images=images[:-1])
    for name in ("icon.png", "icon.ico"):
        print(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), name)


if __name__ == "__main__":
    main()
