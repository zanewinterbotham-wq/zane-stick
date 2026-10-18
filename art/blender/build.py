"""Builds every character style: .glb per style (A-pose) and renders (front, 3/4, tackle lean) in both team colours,
then the labelled concept images with ImageMagick. Background mode only:

  blender -b --factory-startup --python art/blender/build.py -- [style ...] [--no-render] [--no-sheets]

Regenerate art/tools/body.json first when the anatomy changes: npx tsx art/tools/dump-body.ts > art/tools/body.json
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import common as C  # noqa: E402
from styles import STYLES  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
names = [a for a in args if not a.startswith('--')] or list(STYLES)
CHARS = os.path.join(C.ART, 'characters')
CONCEPTS = os.path.join(C.ART, 'concepts')
MAGICK = os.environ.get('MAGICK', os.path.join(os.path.dirname(os.path.dirname(C.ART)), 'art tools', 'imagemagick', 'magick.exe'))
TEAMS = [t['name'] for t in C.BODY['teams']]
VIEWS = [('front', dict(azimuth=0, elev=5)), ('three-quarter', dict(azimuth=38, elev=6)),
         ('action', dict(azimuth=-62, ortho=False, elev=4, lens=40))]

index_path = os.path.join(CHARS, 'index.json')
index = json.load(open(index_path, encoding='utf-8')) if os.path.exists(index_path) else {}

for name in names:
    st = STYLES[name]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = C.build_character(st)
    C.set_pose(objs, C.A_POSE, ground=False)
    tris = C.tri_count(objs)
    C.apply_looks(lambda m, r, c: C.export_look(m, r, c), 0)
    glb = os.path.join(CHARS, name, name + '.glb')
    C.export_glb(objs, glb, normals=not st.get('flat'))  # flat styles: three.js flat-shades a mesh without normals
    size = os.path.getsize(glb)
    index[name] = dict(title=st['title'], pitch=st['pitch'], triangles=tris, bytes=size, headScale=st['K']['head'],
                       file=f'{name}/{name}.glb')
    print(f'STYLE {name}: {tris} triangles, {size / 1024:.1f} KB')
    if '--no-render' in args:
        continue
    stage = C.Stage()
    out = os.path.join(CONCEPTS, 'renders', name)
    os.makedirs(out, exist_ok=True)
    for team, tname in enumerate(TEAMS):
        C.apply_looks(st['look'], team)
        for view, kw in VIEWS:
            C.set_pose(objs, C.ACTION if view == 'action' else C.A_POSE)
            kw = dict(kw, azimuth=st.get('action_az', kw['azimuth'])) if view == 'action' else kw
            stage.shoot(objs, os.path.join(out, f'{tname}-{view}.png'), **kw)

os.makedirs(CHARS, exist_ok=True)
with open(index_path, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(dict(sorted(index.items())), f, indent=1)
    f.write('\n')


def magick(*a):
    subprocess.run([MAGICK, *a[:-1], '-depth', '8', a[-1]], check=True)


if '--no-render' not in args and '--no-sheets' not in args:
    FONT = os.path.join(os.path.dirname(MAGICK), '..', 'fonts')
    font = next((os.path.join(dp, f) for dp, _, fs in os.walk(FONT) for f in fs if f.startswith('LilitaOne')), None)
    fopt = ['-font', font] if font else []
    pretty = {'harbor-gulls': 'Harbor Gulls', 'ridge-foxes': 'Ridge Foxes'}
    for name in STYLES:
        r = os.path.join(CONCEPTS, 'renders', name)
        if not os.path.isdir(r):
            continue
        tiles = []
        for t in TEAMS:
            for v, _ in VIEWS:
                tiles += ['-label', f'{pretty[t]} - {v}', os.path.join(r, f'{t}-{v}.png')]
        magick('montage', *fopt, '-pointsize', '18', *tiles, '-tile', '3x2', '-geometry', '+6+6', '-background', '#1d1f24',
               '-fill', '#e8e8e8', '-title', f"{STYLES[name]['title']}: {STYLES[name]['pitch']}", os.path.join(CONCEPTS, name + '.png'))
    heroes = []
    for name in STYLES:
        r = os.path.join(CONCEPTS, 'renders', name)
        if not os.path.isdir(r):
            continue
        hero = os.path.join(CONCEPTS, 'renders', name, 'hero.png')
        magick(os.path.join(r, 'harbor-gulls-three-quarter.png'), os.path.join(r, 'ridge-foxes-action.png'), '+append', '-resize', '50%', hero)
        tri = index.get(name, {}).get('triangles', '?')
        kb = index.get(name, {}).get('bytes', 0) / 1024
        heroes += ['-label', f"{STYLES[name]['title']} ({name}) - {tri} tris, {kb:.0f} KB", hero]
    magick('montage', *fopt, '-pointsize', '16', *heroes, '-tile', '4x', '-geometry', '+8+8', '-background', '#1d1f24',
           '-fill', '#e8e8e8', '-title', 'Zane Stick - character styles (left: Harbor Gulls 3/4, right: Ridge Foxes tackle lean)',
           os.path.join(CONCEPTS, 'sheet.png'))
print('DONE')
