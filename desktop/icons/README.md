# App icons

Every Yuzuno icon is the Yuzuno character, from one file:
[`web/src/assets/yuzu-character.png`](../../web/src/assets/yuzu-character.png).
Its source and license are in [the asset notes](../../web/src/assets/README.md).
The web UI and the README header use that file directly. The files here are made from it by
[`generate.py`](generate.py) (needs Pillow):

```sh
python3 desktop/icons/generate.py
```

| File | What it is | Used by |
| --- | --- | --- |
| `icon.png` | The character image, unchanged (128×128) | The window icon on macOS and Linux; the macOS app icon, which Tauri's bundler makes from it |
| `icon.ico` | 16, 24, 32, 48 and 64 px, downscaled with Lanczos, plus the 128 px image itself | The Windows executable's icon, which is also its window icon, and the installer's (`desktop/tauri.conf.json`) |

The script copies and downscales; it does not redraw. Run it again whenever the character
image changes, and commit what it writes.

## The 128 px limit

128×128 is the largest the character exists at. Nothing here is enlarged:

- There is no 256 px entry in `icon.ico`. Windows scales the 128 px image for its largest views.
- The macOS icon is also built from the 128 px image, so Retina sizes are scaled up by macOS.

Sharper large icons need a larger version of the same character, not a new drawing. Adding one
means replacing the source image and running the script again.

## iOS and other platforms

There is no iOS app yet. When there is one, its icon follows the same rule: the same
character file, converted rather than redrawn. Two things it will need that this source does
not provide yet:

- a 1024×1024 image, so the larger version described above;
- an opaque background, because iOS app icons cannot be transparent. The character goes on a
  plain colour chosen at that time.
