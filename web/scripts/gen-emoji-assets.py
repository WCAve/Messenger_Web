#!/usr/bin/env python3
"""
Builds web/public/emoji/ from upstream emoji sets. Run by hand when updating; the output is committed.

  git clone --depth 1 --filter=blob:none --sparse https://github.com/googlefonts/noto-emoji.git noto
  (cd noto && git sparse-checkout set --no-cone /2D/fonts/Noto-COLRv1.ttf /2D/fonts/LICENSE)
  git clone --depth 1 --filter=blob:none --sparse https://github.com/jdecked/twemoji.git twemoji
  (cd twemoji && git sparse-checkout set --no-cone /assets/72x72/ /LICENSE-GRAPHICS)
  git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/fluentui-emoji.git fluent
  (cd fluent && git sparse-checkout set --no-cone '/assets/*/metadata.json' '/assets/*/3D/*.png' '/assets/*/*/3D/*.png' /LICENSE)
  python3 web/scripts/gen-emoji-assets.py <dir with the three clones> web/public/emoji

Image files are named by the emoji's code points in lowercase hex, joined by "-", without U+FE0F.
"""
import json, os, shutil, sys
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
SIZE = 64
TONES = ['Default', 'Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark']

def key(cps):
    return '-'.join(c.lower() for c in cps if c.lower() != 'fe0f')

def save_png(img_path, dest):
    im = Image.open(img_path).convert('RGBA')
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    im.save(dest, 'WEBP', quality=88, method=6)

# Noto (font)
os.makedirs(f'{out}/noto', exist_ok=True)
shutil.copy(f'{src}/noto/2D/fonts/Noto-COLRv1.ttf', f'{out}/noto/NotoColorEmoji.ttf')
shutil.copy(f'{src}/noto/2D/fonts/LICENSE', f'{out}/noto/LICENSE.txt')

# Twemoji (72px PNGs, renamed)
os.makedirs(f'{out}/twemoji', exist_ok=True)
n = 0
for f in os.listdir(f'{src}/twemoji/assets/72x72'):
    if not f.endswith('.png'):
        continue
    shutil.copy(f'{src}/twemoji/assets/72x72/{f}', f'{out}/twemoji/{key(f[:-4].split("-"))}.png')
    n += 1
shutil.copy(f'{src}/twemoji/LICENSE-GRAPHICS', f'{out}/twemoji/LICENSE.txt')
print('twemoji', n)

# Fluent 3D (256px PNGs → 64px WebP)
os.makedirs(f'{out}/fluent', exist_ok=True)
n = 0
base = f'{src}/fluent/assets'
for name in os.listdir(base):
    meta_path = f'{base}/{name}/metadata.json'
    if not os.path.exists(meta_path):
        continue
    meta = json.load(open(meta_path))
    def first_png(d):
        if not os.path.isdir(d):
            return None
        pngs = sorted(p for p in os.listdir(d) if p.endswith('.png'))
        return f'{d}/{pngs[0]}' if pngs else None
    if meta.get('unicodeSkintones'):
        for tone, cps in zip(TONES, meta['unicodeSkintones']):
            p = first_png(f'{base}/{name}/{tone}/3D')
            if p:
                save_png(p, f'{out}/fluent/{key(cps.split())}.webp'); n += 1
    else:
        p = first_png(f'{base}/{name}/3D')
        if p:
            save_png(p, f'{out}/fluent/{key(meta["unicode"].split())}.webp'); n += 1
shutil.copy(f'{src}/fluent/LICENSE', f'{out}/fluent/LICENSE.txt')
print('fluent', n)
