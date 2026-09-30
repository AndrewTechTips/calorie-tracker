# Profile cover sources

These SVGs are the **design sources** for the Settings profile covers. The app
ships the rendered rasters in `frontend/public/assets/banners/<id>.webp`, never
these files.

## Why the app does not use the SVGs directly

Each cover uses a large `feGaussianBlur` plus an `feTurbulence` grain. A browser
rasterizes an SVG `<img>` on the main thread, and measured in Chrome one cover
took **~170-180 ms per rasterization on a MacBook**. It re-rasterized on size
changes and animation (the Settings sheet's slide-up), and once per picker
tile. On a phone that was a ~1 s freeze opening Settings and a janky cover
picker. A pre-rendered WebP decodes once, in milliseconds, and the compositor
moves it for free.

## Regenerating after an edit

1200x400 matches ~3x DPR at the card's width. Iron keeps a higher quality
because its fine knurl texture smears at 88.

```bash
cd frontend/design/banners
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for id in ember aurora citrus glacier iron grove; do
  printf '<body style="margin:0"><img src="file://%s/%s.svg" style="display:block;width:1200px;height:400px;object-fit:cover">' "$PWD" "$id" > "/tmp/$id.html"
  "$CH" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,400 \
    --allow-file-access-from-files --screenshot="/tmp/$id.png" "file:///tmp/$id.html"
done
python3 -c "
from PIL import Image
for id in ['ember','aurora','citrus','glacier','iron','grove']:
    im = Image.open(f'/tmp/{id}.png').convert('RGB')
    im.save(f'../../public/assets/banners/{id}.webp', 'WEBP', quality=94 if id == 'iron' else 88, method=6)
    # The picker tiles use a tiny thumbnail (bannerThumbSrc), never the full cover.
    im.resize((288, 96), Image.LANCZOS).save(
        f'../../public/assets/banners/{id}-thumb.webp', 'WEBP', quality=86, method=6)
"
```

A new preset also needs its id in `js/profileBanner.js::BANNER_PRESETS`,
`backend/models.py::PROFILE_BANNER_PRESETS`, and an i18n label in both
languages.
