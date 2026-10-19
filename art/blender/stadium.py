"""Builds the stadiums: art/stadiums/<id>/<id>.glb + info.json, and a render per stadium in art/concepts/stadiums/<id>.png.
Background mode only:

  blender -b --factory-startup --python art/blender/stadium.py -- [id ...] [--no-render]

Each stadium is one low-poly mesh with a handful of flat-colour materials (and a 256x24 crowd sprite strip), drawn
round the playing area; the field itself is the game's own mesh. The padded wall sits on the physics barrier.
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import stadium_dolphinhills as dolphinhills  # noqa: E402
import stadium_lib as S  # noqa: E402
from stadium_lib import HX, HY, Mesh  # noqa: E402

ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ART, 'stadiums')
CONCEPTS = os.path.join(ART, 'concepts', 'stadiums')
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


# ---------------------------------------------------------------- shared pieces ----------------------------------------
def ground(m, mat, z=-0.06, r=320):
    m.quad([(-r, -r, z), (r, -r, z), (r, r, z), (-r, r, z)], mat)


def wall(m, pad, trim, ads=(), h=1.3):
    """The padded wall on the physics barrier, with advertising boards along its inner face."""
    m.ring(0, 0.5, 0, h, trim, ('top', 'inner', 'outer'), inner_mat=pad)
    for s in 'EWNS':
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        n = max(1, int(2 * Q // 6))
        for i in range(n):
            col = ads[i % len(ads)] if ads else pad
            u0, u1 = -Q + i * 2 * Q / n + 0.1, -Q + (i + 1) * 2 * Q / n - 0.1
            m.solid(T, u0, u1, P - 0.05, P, 0.2, h - 0.2, col, skip=('bot', 'hi_v', 'lo_u', 'hi_u'))


def tree(m, x, y, s, trunk, leaf, rnd, leaf2=None):
    m.cyl(x, y, 0, 2.0 * s, 0.28 * s, trunk, 5)
    m.cyl(x, y, 1.4 * s, 5.2 * s, 1.9 * s * (0.85 + 0.3 * rnd.random()), leaf, 6, 0)
    m.cyl(x, y, 3.4 * s, 7.0 * s, 1.35 * s, leaf2 or leaf, 6, 0)


def mast(m, x, y, h, pole, lamp, frame, cols=4, rows=3):
    """Floodlight tower with a lamp bank turned toward the field."""
    m.cyl(x, y, 0, h, 0.4, pole, 6, 0.22)
    rot = math.atan2(-y, -x) + math.pi / 2
    bw, bh = cols * 1.1, rows * 1.1
    m.box(x, y, h + bh / 2, bw + 0.4, 0.5, bh + 0.4, frame, rot=rot)
    for c in range(cols):
        for r in range(rows):
            u = (c - (cols - 1) / 2) * 1.1
            # lamps stand out of the frame toward the field
            dx, dy = math.cos(rot), math.sin(rot)
            fx, fy = -dy, dx  # toward the field (perpendicular to the bank)
            if fx * (-x) + fy * (-y) < 0:
                fx, fy = -fx, -fy
            m.box(x + u * dx + fx * 0.3, y + u * dy + fy * 0.3, h + 0.55 + r * 1.1, 0.85, 0.2, 0.85, lamp, rot=rot)


def scoreboard(m, x, y, w, h, z0, body, face, lit, rot=0.0, legs=None):
    if legs:
        for sx in (-w * 0.35, w * 0.35):
            m.box(x + sx * math.cos(rot), y + sx * math.sin(rot), z0 / 2, 0.5, 0.5, z0, legs)
    m.box(x, y, z0 + h / 2, w, 0.8, h, body, rot=rot)
    fx, fy = -math.sin(rot), math.cos(rot)
    sgn = -1 if (fx * x + fy * y) > 0 else 1  # face the field
    m.box(x + sgn * fx * 0.45, y + sgn * fy * 0.45, z0 + h / 2, w - 0.8, 0.12, h - 0.8, face, rot=rot)
    for i, (cx, cz) in enumerate([(-0.28, 0.58), (-0.1, 0.58), (0.1, 0.58), (0.28, 0.58), (-0.2, 0.25), (0.2, 0.25)]):
        m.box(x + sgn * fx * 0.55 + cx * (w - 2) * math.cos(rot), y + sgn * fy * 0.55 + cx * (w - 2) * math.sin(rot),
              z0 + cz * h, 0.13 * w, 0.1, 0.22 * h, lit, rot=rot)


def crowd_for(m, name, seats, shirts, skins, **kw):
    path = S.crowd_sheet(os.path.join(OUT, name, 'crowd.png'), seats, shirts, skins, **kw)
    return m.mat('crowd', '#ffffff', rough=1.0, tex=path)


JERSEYS = ['#c0392b', '#2e86c1', '#f4d03f', '#ecf0f1', '#27ae60', '#8e44ad', '#e67e22', '#2c3e50', '#d35400', '#ffffff']
SKINS = ['#f1c7a0', '#e0ac7c', '#c68a5e', '#8d5a3b', '#5e3a24', '#fbd9b8']


# ---------------------------------------------------------------- stadiums -------------------------------------------
def highschool(m):
    rnd = random.Random(11)
    for k, v in dict(grass='#5f9a45', track='#b4563c', line='#ece7dc', metal='#b7bec6', metal_d='#838b93', fence='#9aa1a8', pole='#6c4d34',
                     white='#efefe8', navy='#1f3f78', red='#b82430', trunk='#5b3d26', leaf='#3f7d34', leaf2='#4f9040', hill='#7aa35a',
                     board='#1c2630', face='#10331f', lit='#ffd45a', glass='#5c7a92', roofm='#59656e', brick='#a0523d').items():
        m.mat(k, v, emit=1.0 if k == 'lit' else 0.0)
    crowd = crowd_for(m, 'highschool', '#838b93', JERSEYS[:5], SKINS, empty=0.45, seed=3)
    ground(m, 'grass')
    wall(m, 'navy', 'white', ('white', 'red', 'navy'), h=1.2)
    # running track round the field, lane lines on it
    m.ring(1.1, 9.1, -0.05, -0.04, 'track', ('top',))
    for i in range(1, 7):
        m.ring(1.1 + i * 8 / 7 - 0.04, 1.1 + i * 8 / 7 + 0.04, -0.045, -0.035, 'line', ('top',))
    # chain-link fence: posts and rails
    for s in 'EWNS':
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        for i in range(int(2 * Q // 5) + 1):
            u = -Q - 10 + i * 5
            m.solid(T, u - 0.06, u + 0.06, P + 9.9, P + 10.05, 0, 2.4, 'fence')
    for z in (0.3, 1.2, 2.3):
        m.ring(9.95, 10.0, z, z + 0.08, 'fence', ('top', 'inner', 'outer', 'bot'))
    # home bleachers (east): metal rows, sparse crowd; visitors (west) are shorter
    d, z = m.stand(['E'], 12, 14, 0.5, 0.75, 0, 'metal', 'metal_d', crowd, rnd, L=46, back='metal_d')
    d2, z2 = m.stand(['W'], 12, 6, 0.5, 0.75, 0, 'metal', 'metal_d', crowd, rnd, L=18, back='metal_d')
    for sd, dd, zz, LL in (('E', d, z, 46), ('W', d2, z2, 18)):
        T = S.FRAMES[sd]
        for u in range(-LL, LL + 1, 6):
            m.solid(T, u - 0.05, u + 0.05, S.HALF[sd][0] + dd - 0.1, S.HALF[sd][0] + dd, zz, zz + 1.1, 'fence')
        m.solid(T, -LL, LL, S.HALF[sd][0] + dd - 0.1, S.HALF[sd][0] + dd, zz + 1.0, zz + 1.08, 'fence')
    # press box on the home stands, scoreboard behind the north end zone
    m.box(HX + 21.5, 0, z + 1.7, 7, 16, 3.4, 'white')
    m.box(HX + 21.5 - 3.53, 0, z + 1.9, 0.1, 14, 1.5, 'glass')
    m.box(HX + 21.5, 0, z + 3.55, 8, 17, 0.3, 'roofm')
    scoreboard(m, 0, -HY - 16, 14, 5.5, 5.0, 'board', 'face', 'lit', legs='pole')
    m.box(0, -HY - 15.2, 4.1, 15, 0.4, 0.8, 'red')
    m.stand(['N'], 12, 5, 0.5, 0.75, 0, 'metal', 'metal_d', crowd, rnd, L=22, back='metal_d')
    for x, y in ((-HX - 6, -HY + 4), (HX + 6, -HY + 4), (-HX - 6, HY - 4), (HX + 6, HY - 4)):
        m.cyl(x, y, 0, 21, 0.28, 'pole', 6, 0.2)
        m.box(x, y, 21.6, 3.6, 0.4, 1.6, 'metal_d', rot=math.atan2(-y, -x) + math.pi / 2)
    for i in range(40):
        a = rnd.random() * 2 * math.pi
        r = rnd.uniform(1.0, 1.6)
        x, y = math.cos(a) * (HX + 38) * r, math.sin(a) * (HY + 30) * r
        if abs(x) < HX + 50 and abs(y) < HY + 24:
            continue
        tree(m, x, y, rnd.uniform(1.4, 2.4), 'trunk', 'leaf', rnd, 'leaf2')
    for i in range(6):
        a = 2 * math.pi * i / 6 + 0.3
        m.cyl(math.cos(a) * 260, math.sin(a) * 300, -0.5, 26 + 8 * (i % 2), 90, 'hill', 9, 30)
    return dict(sky='#8fc7ee', fog=['#b9d9ee', 90, 300], hemi=['#e4f0ff', '#456b31', 1.1], sun=['#ffffff', 2.2],
                cam=((-24, -52, 13), (14, 10, 2)))


def college(m):
    rnd = random.Random(21)
    for k, v in dict(concrete='#bdb8ad', concrete_d='#8f8b82', maroon='#7b1e2d', gold='#e0b020', cream='#efe6cf', dark='#26262c', plaza='#8e8a84',
                     glass='#2a4a5c', white='#f1f1ea', blue='#2a5fd0').items():
        m.mat(k, v)
    m.mat('screen', '#3f8cff', emit=1.2)
    m.mat('lamp', '#fff6d8', emit=2.0)
    crowd = crowd_for(m, 'college', '#43121b', ['#7b1e2d', '#e0b020', '#f1f1ea', '#7b1e2d', '#2c2c32', '#e0b020'], SKINS, empty=0.05, seed=5)
    ground(m, 'plaza')
    wall(m, 'maroon', 'gold', ('white', 'gold', 'maroon'), h=1.4)
    d, z = m.stand('EWNS', 3, 16, 0.5, 0.85, 0, 'maroon', 'concrete', crowd, rnd)
    # concourse with a banner band, then the steeper upper deck in gold
    m.ring(d, d + 3.2, z - 0.01, z, 'concrete', ('top',))
    m.ring(d + 3.2, d + 3.2, z, z + 1.0, 'cream', ('inner',))
    d2, z2 = m.stand('EWNS', d + 3.2, 18, 0.62, 0.8, z, 'gold', 'concrete_d', crowd, rnd)
    m.ring(d2, d2 + 1.0, z2 - 0.01, z2, 'concrete', ('top',))
    m.ring(d2 + 1.0, d2 + 1.0, 0, z2 + 1.0, 'concrete_d', ('outer',))
    for s in 'EWNS':  # banners standing above the rim, facing the field
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        for i, u in enumerate(range(-int(Q) + 8, int(Q) - 6, 13)):
            m.solid(T, u - 2.4, u + 2.4, P + d2 + 1.0, P + d2 + 1.15, z2, z2 + 7, 'maroon' if i % 2 else 'gold', skip=('bot', 'top', 'lo_u', 'hi_u', 'hi_v'))
            m.solid(T, u - 0.6, u + 0.6, P + d2 + 1.0, P + d2 + 1.16, z2 + 3, z2 + 5, 'cream' if i % 2 else 'maroon', skip=('bot', 'top', 'lo_u', 'hi_u', 'hi_v'))
    # end-zone video board and press box
    m.box(0, HY + d2 + 3, z2 + 7, 24, 1.5, 9, 'dark')
    m.box(0, HY + d2 + 2.2, z2 + 7, 22, 0.1, 7.4, 'screen')
    m.box(HX + d2 + 2.6, 0, z2 + 2.2, 6, 40, 4.4, 'glass')
    m.box(HX + d2 + 2.6, 0, z2 + 4.6, 7, 42, 0.5, 'white')
    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        x, y = sx * (HX + d2 + 4), sy * (HY + d2 - 6)
        m.cyl(x, y, z2, z2 + 12, 0.3, 'concrete_d', 6, 0.2)
        rot = math.atan2(-y, -x) + math.pi / 2
        m.box(x, y, z2 + 13.2, 4.6, 0.4, 2.4, 'dark', rot=rot)
        m.box(x - 0.2 * sx, y - 0.2 * sy, z2 + 13.2, 4.2, 0.2, 2.0, 'lamp', rot=rot)
    return dict(sky='#a6cbe9', fog=['#c7dcee', 100, 330], hemi=['#e0eeff', '#52623f', 1.1], sun=['#fff7e8', 2.2],
                cam=((-30, -56, 14), (18, 24, 6)))


def pro(m):
    rnd = random.Random(31)
    for k, v in dict(steel='#cdd2d8', steel_d='#8d949c', roof='#3b4048', under='#e8ecef', seat='#1a3a8a', seat2='#c9c9d4', suite='#17222e',
                     concrete='#b0b3b6', plaza='#6e7174', white='#f5f5f5', silver='#9aa3ab', red='#c4261d').items():
        m.mat(k, v, metal=0.3 if k == 'suite' else 0.0, rough=0.35 if k == 'suite' else 0.9)
    m.mat('led', '#fff7e0', emit=2.4)
    m.mat('video', '#37d0ff', emit=1.3)
    crowd = crowd_for(m, 'pro', '#101f4e', ['#1a3a8a', '#f5f5f5', '#c4261d', '#1a3a8a', '#f4d03f', '#2c3e50'], SKINS, empty=0.04, seed=7, sparkle='#ffffff')
    ground(m, 'plaza')
    wall(m, 'seat', 'silver', ('white', 'red', 'steel_d', 'white'), h=1.5)
    d, z = m.stand('EWNS', 3, 14, 0.5, 0.8, 0, 'seat', 'steel_d', crowd, rnd)
    # suite band: dark glass with mullions
    m.ring(d, d + 1.4, z - 0.01, z, 'concrete', ('top',))
    zs = z + 4.5
    m.ring(d + 1.4, d + 1.4, z, zs, 'suite', ('inner',))
    for s in 'EWNS':
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        for u in range(-int(Q) - int(d), int(Q) + int(d) + 1, 6):
            if abs(u) <= Q + d + 1.4:
                m.solid(T, u - 0.12, u + 0.12, P + d + 1.3, P + d + 1.4, z, zs, 'steel', skip=('bot', 'hi_v', 'lo_u', 'hi_u'))
        m.solid(T, -Q - d - 1.4, Q + d + 1.4, P + d + 1.3, P + d + 1.45, zs, zs + 0.3, 'steel', skip=('bot', 'hi_v', 'lo_u', 'hi_u'))
    d2, z2 = m.stand('EWNS', d + 1.5, 24, 0.65, 0.78, zs + 0.3, 'seat2', 'steel_d', crowd, rnd)
    m.ring(d2, d2 + 1.0, z2 - 0.01, z2, 'concrete', ('top',))
    m.ring(d2 + 1.0, d2 + 1.0, 0, z2 + 1.0, 'steel_d', ('outer',))
    # the roof ring: a flat slab over the upper deck with an open middle, lit underside edge and columns
    zr = z2 + 5.5
    m.ring(d + 1.0, d2 + 9, zr, zr + 0.7, 'roof', ('top', 'inner', 'outer'), inner_mat='steel')
    m.ring(d + 1.0, d2 + 9, zr - 0.02, zr, 'under', ('bot',))
    m.ring(d + 1.0, d + 1.3, zr - 0.5, zr, 'led', ('inner',))
    for s in 'EWNS':
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        m.solid(T, -(Q + d + 6), (Q + d + 6), P + d + 3.5, P + d + 3.9, zr - 4.5, zr - 0.5, 'video' if s in 'EW' else 'led', skip=('bot', 'hi_v', 'lo_u', 'hi_u', 'top'))
        for u in range(-int(Q) + 6, int(Q) - 5, 22):
            m.box(*(*T(u, P + d2 + 9.2), (zr + 0.7) / 2), 1.1, 1.1, zr + 0.7, 'steel_d')
    # light towers outside the corners
    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        mast(m, sx * (HX + d2 + 20), sy * (HY + d2 - 4), 46, 'steel_d', 'led', 'roof', 5, 3)
    return dict(sky='#9cc3e4', fog=['#bfd8ee', 110, 340], hemi=['#e3efff', '#4b5a4a', 1.05], sun=['#ffffff', 2.0],
                cam=((-30, -56, 14), (20, 22, 8)))


def night(m):
    rnd = random.Random(41)
    for k, v in dict(grass='#1e3b24', concrete='#4a4f5c', concrete_d='#2f333d', seat='#25408a', seat2='#8a96b8', rail='#8f98a8', dark='#10131c',
                     pad='#122a5c', trim='#e8edf7', ad1='#e8edf7', ad2='#2f9cff', ad3='#ff8a2b', pole='#7c8594', frame='#1b1f2a').items():
        m.mat(k, v)
    m.mat('lamp', '#fffbe6', emit=3.0)
    m.mat('screen', '#3aa6ff', emit=1.4)
    m.mat('star_nofog', '#ffffff', emit=2.0)
    m.mat('moon_nofog', '#fff4cf', emit=1.6)
    crowd = crowd_for(m, 'night', '#161c36', ['#25408a', '#e8edf7', '#ff8a2b', '#2f9cff', '#8a96b8'], SKINS, empty=0.08, seed=9, sparkle='#fff6b0')
    ground(m, 'grass')
    wall(m, 'pad', 'trim', ('ad1', 'ad2', 'ad3'), h=1.3)
    d, z = m.stand('EWNS', 3, 20, 0.52, 0.8, 0, 'seat', 'concrete_d', crowd, rnd)
    m.ring(d, d + 1.2, z - 0.01, z, 'concrete', ('top',))
    m.ring(d + 1.2, d + 1.2, 0, z + 1.1, 'concrete_d', ('outer',))
    m.box(0, HY + d + 2.5, z + 5, 18, 1.2, 7, 'frame')
    m.box(0, HY + d + 1.8, z + 5, 16.5, 0.1, 5.6, 'screen')
    for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        mast(m, sx * (HX + d + 3), sy * (HY + d - 8), 40, 'pole', 'lamp', 'frame', 4, 3)
    # a glowing rim light round the bowl
    m.ring(d + 1.2, d + 1.3, z + 1.0, z + 1.15, 'lamp', ('top', 'inner'))
    for i in range(110):  # stars and a moon beyond the fog
        a, e = rnd.random() * 2 * math.pi, rnd.uniform(0.15, 1.2)
        r = 330
        c = (math.cos(a) * math.cos(e) * r, math.sin(a) * math.cos(e) * r, math.sin(e) * r)
        sz = rnd.uniform(0.7, 1.6)
        m.tri([c, (c[0] + sz, c[1], c[2]), (c[0], c[1], c[2] + sz)], 'star_nofog')
    m.cyl(-200, 250, 150, 150.5, 14, 'moon_nofog', 12)
    return dict(sky='#0a1230', fog=['#0d1738', 70, 300], hemi=['#8fa6e0', '#2a3a30', 1.1], sun=['#fff0d0', 2.3],
                cam=((-30, -52, 14), (16, 22, 6)))


def backyard(m):
    rnd = random.Random(51)
    for k, v in dict(grass='#6ea24a', lawn='#84b858', wood='#a9753f', wood_d='#7b512b', post='#8c5d32', trunk='#5a3c24', leaf='#3d7d2f', leaf2='#559a3a',
                     siding1='#e8d9a8', siding2='#9dc3d9', siding3='#d98c7a', roofa='#7a3f33', roofb='#4d5a66', door='#3a5ea6', win='#b8dff2', white='#f3f1ea',
                     can='#8d949a', truck='#c43a2b', truck_d='#2a2a2e', chair='#3a8f8f', swing='#d8b24a', hill='#8dbf6a', dirt='#b89868').items():
        m.mat(k, v)
    crowd = crowd_for(m, 'backyard', '#84b858', JERSEYS, SKINS, empty=0.55, seed=13)
    ground(m, 'grass')
    # picket-fence wall: wood with two rails and posts
    m.ring(0, 0.5, 0, 1.25, 'wood', ('top', 'inner', 'outer'))
    for z in (0.35, 0.85):
        m.ring(-0.04, 0, z, z + 0.14, 'wood_d', ('top', 'inner'))
    for s in 'EWNS':
        P, Q = S.HALF[s]
        T = S.FRAMES[s]
        for u in range(-int(Q), int(Q) + 1, 4):
            m.solid(T, u - 0.12, u + 0.12, P - 0.1, P + 0.5, 0, 1.55, 'post')
    # lawn banks with spectators on the sidelines, a dirt path round the yard
    m.stand(['E'], 3, 5, 0.3, 1.5, 0, 'lawn', 'grass', crowd, rnd, L=40, crowd_h=1.0)
    m.stand(['W'], 3, 5, 0.3, 1.5, 0, 'lawn', 'grass', crowd, rnd, L=40, crowd_h=1.0)
    for sx in (-1, 1):  # camp chairs on the bank
        for y in range(-30, 31, 7):
            m.box(sx * (HX + 4.4), y + rnd.uniform(-1, 1), 0.55, 0.6, 0.6, 0.5, 'chair')
    # houses round the edge, each facing the field
    def house(x, y, w, dpt, h, siding, roof, along):
        m.box(x, y, h / 2, w, dpt, h, siding)
        m.roof(x, y, w + 0.8, dpt + 0.8, h, h + 2.6, roof, roof, along)
        fx, fy = (-1 if x > 0 else 1, 0) if abs(x) > HX + 4 else (0, -1 if y > 0 else 1)
        face = (x + fx * (w / 2 if fx else 0), y + fy * (dpt / 2 if fy else 0))
        if fx:
            face = (x + fx * w / 2, y)
            m.box(face[0], y, 1.1, 0.2, 1.1, 2.2, 'door')
            m.box(face[0], y + 2.6, 2.3, 0.2, 1.6, 1.4, 'win')
            m.box(face[0], y - 2.6, 2.3, 0.2, 1.6, 1.4, 'win')
        else:
            face = (x, y + fy * dpt / 2)
            m.box(x, face[1], 1.1, 1.1, 0.2, 2.2, 'door')
            m.box(x + 2.6, face[1], 2.3, 1.6, 0.2, 1.4, 'win')
            m.box(x - 2.6, face[1], 2.3, 1.6, 0.2, 1.4, 'win')
    for i, y in enumerate((-48, -24, 0, 24, 48)):
        house(HX + 22, y + rnd.uniform(-2, 2), 9, 10, 5, ('siding1', 'siding2', 'siding3')[i % 3], ('roofa', 'roofb')[i % 2], 'x')
        house(-HX - 22, y + rnd.uniform(-2, 2), 9, 10, 5, ('siding2', 'siding3', 'siding1')[i % 3], ('roofb', 'roofa')[i % 2], 'x')
    for i, x in enumerate((-18, 0, 18)):
        house(x, HY + 16, 11, 9, 5.5, ('siding3', 'siding1', 'siding2')[i], ('roofa', 'roofb', 'roofa')[i], 'y')
        house(x, -HY - 16, 11, 9, 5.5, ('siding1', 'siding2', 'siding3')[i], ('roofb', 'roofa', 'roofb')[i], 'y')
    # props: truck, garbage cans, swing set, trees
    m.box(-12, -HY - 6, 0.9, 2.3, 5.4, 1.1, 'truck')
    m.box(-12, -HY - 7.2, 1.9, 2.1, 2.4, 0.9, 'truck')
    for dx in (-1.1, 1.1):
        for dy in (-1.8, 1.8):
            m.cyl(-12 + dx, -HY - 6 + dy, 0.0, 0.7, 0.4, 'truck_d', 8, cap=True)
    for i in range(6):
        m.cyl(-HX - 1.5, -40 + i * 15, 0, 1.0, 0.35, 'can', 8)
    for sx in (-2.5, 2.5):
        m.cyl(HX + 8 + sx, HY - 6, 0, 3.2, 0.1, 'swing', 5)
    m.box(HX + 8, HY - 6, 3.2, 6, 0.15, 0.15, 'swing')
    for i in range(30):
        a = rnd.random() * 2 * math.pi
        x, y = math.cos(a) * (HX + 60) * rnd.uniform(1, 1.7), math.sin(a) * (HY + 50) * rnd.uniform(1, 1.7)
        if abs(x) < HX + 36 and abs(y) < HY + 26:
            continue
        tree(m, x, y, rnd.uniform(1.6, 2.8), 'trunk', 'leaf', rnd, 'leaf2')
    for i in range(5):
        a = 2 * math.pi * i / 5 + 0.7
        m.cyl(math.cos(a) * 250, math.sin(a) * 280, -0.5, 30, 100, 'hill', 9, 30)
    return dict(sky='#86c5f0', fog=['#cfe6f2', 90, 280], hemi=['#e8f3ff', '#5a7a3a', 1.15], sun=['#fff1d2', 2.3],
                cam=((-22, -50, 10), (12, 14, 2)))


def crater(m):
    rnd = random.Random(61)
    for k, v in dict(rock='#4c4057', rock2='#6a5a78', rock3='#2a2430', glow_pad='#1d1a22', ash='#241d24', bone='#d8cfc0', gold='#7c6a3a').items():
        m.mat(k, v, rough=0.95)
    m.mat('lava', '#ff5a1a', emit=2.2, rough=0.6)
    m.mat('lava2', '#ffb02e', emit=2.6, rough=0.6)
    m.mat('crystal', '#ff3d6e', emit=1.2, rough=0.3)
    crowd = crowd_for(m, 'crater', '#2e2434', ['#3a3342', '#a02a36', '#6a3a9a', '#554a60', '#d04a1c'], ['#a33a3a', '#6a3a8a', '#555566', '#b86a2a'], empty=0.04, seed=17, sparkle='#ffa030')
    ground(m, 'ash')
    m.ring(30, 46, -0.05, -0.04, 'lava', ('top',))   # lava moat round the arena
    m.ring(30, 31, -0.05, -0.03, 'lava2', ('top',))
    m.ring(45, 46, -0.05, -0.03, 'lava2', ('top',))
    wall(m, 'glow_pad', 'lava2', ('rock3', 'rock2'), h=1.4)
    d, z = m.stand('EWNS', 3, 10, 0.6, 0.7, 0, 'rock', 'rock3', crowd, rnd)
    m.ring(d, d + 3.0, z - 0.01, z, 'lava', ('top',))      # lava stream between the tiers
    d2, z2 = m.stand('EWNS', d + 3.0, 14, 0.7, 0.7, z, 'rock2', 'rock3', crowd, rnd)
    m.ring(d2, d2 + 1.5, z2 - 0.01, z2, 'rock', ('top',))
    m.ring(d2 + 1.5, d2 + 1.5, 0, z2 + 1.0, 'rock3', ('outer',))
    for i in range(34):  # glowing crystal spires on the rim
        side = rnd.choice('EWNS')
        P, Q = S.HALF[side]
        u = rnd.uniform(-Q, Q)
        x, y = S.FRAMES[side](u, P + d2 + 3 + rnd.uniform(0, 14))
        h = rnd.uniform(5, 22)
        m.cyl(x, y, z2 - 1, z2 + h, rnd.uniform(1, 2.2), 'crystal' if i % 3 == 0 else 'rock2', 5, 0)
    for i in range(14):  # a distant volcano and spires beyond the moat
        a = rnd.random() * 2 * math.pi
        m.cyl(math.cos(a) * 170, math.sin(a) * 190, -0.5, rnd.uniform(25, 50), rnd.uniform(12, 24), 'rock', 6, 0)
    m.cyl(0, HY + 170, -1, 70, 70, 'rock3', 10, 14)
    m.cyl(0, HY + 170, 69.5, 70, 14, 'lava2', 10, 10)
    for x, y in ((-HX - 18, -HY - 4), (HX + 18, HY + 4)):  # bone-white horned gates
        m.cyl(x, y, z2, z2 + 14, 1.0, 'bone', 5, 0.3)
    return dict(sky='#3b0f10', fog=['#4d1712', 40, 250], hemi=['#ffb090', '#6a3028', 1.5], sun=['#ffc896', 2.4],
                cam=((-28, -54, 14), (16, 18, 6)))


STADIUMS = {
    'highschool': (highschool, 'Hometown High', 'Friday-afternoon high school field: silver bleachers, a track, chain-link fence and a hand-lit scoreboard.'),
    'college': (college, 'State U Bowl', 'Two-deck college bowl in maroon and gold: banners over the rim, a video board and a full house.'),
    'pro': (pro, 'Metro Dome', 'Pro arena with suites, a steep upper deck, a roof ring with a video band and tall light towers.'),
    'night': (night, 'Under the Lights', 'Night game: floodlight masts, a glowing rim, stars and phone lights in the stands.'),
    'backyard': (backyard, 'Backyard Sandlot', 'Neighbourhood backyard behind a picket fence: lawn chairs, houses, a pickup truck and a swing set.'),
    'dolphinhills': (lambda m: dolphinhills.build(m, sys.modules[__name__]), 'Dolphin Hills Stadium',
                     'A coastal high-school stadium down in a bowl: blue end zones, a red eight-lane track, a big blue home stand built into the hill with a press box on top, the school, a baseball diamond, the snack bar and sand seating, and the Pacific right behind.'),
    'crater': (crater, 'Crater Rim', 'Volcanic arena: black rock tiers, lava streams, glowing crystals and a moat of fire.'),
}


# ---------------------------------------------------------------- export and render ----------------------------------
def field_proxy():
    """The game draws the real field; renders need one in the picture (not exported)."""
    Y = 0.9144
    m = Mesh('field')
    for k, v in dict(turf='#2f6b33', turf2='#357439', ez1='#1f3a68', ez2='#c4561a', line='#f4f4ee').items():
        m.mat(k, v)
    W, L = 24.384, 60 * Y
    m.quad([(-W - 6, -L - 6, -0.01), (W + 6, -L - 6, -0.01), (W + 6, L + 6, -0.01), (-W - 6, L + 6, -0.01)], 'turf')
    for i, y in enumerate(range(-50, 50, 5)):
        if i % 2 == 0:
            m.quad([(-W, y * Y, 0), (W, y * Y, 0), (W, (y + 5) * Y, 0), (-W, (y + 5) * Y, 0)], 'turf2')
    m.quad([(-W, -60 * Y, 0.001), (W, -60 * Y, 0.001), (W, -50 * Y, 0.001), (-W, -50 * Y, 0.001)], 'ez1')
    m.quad([(-W, 50 * Y, 0.001), (W, 50 * Y, 0.001), (W, 60 * Y, 0.001), (-W, 60 * Y, 0.001)], 'ez2')
    for y in range(-50, 51, 5):
        m.quad([(-W, y * Y - 0.05, 0.002), (W, y * Y - 0.05, 0.002), (W, y * Y + 0.05, 0.002), (-W, y * Y + 0.05, 0.002)], 'line')
    for x in (-W, W):
        m.quad([(x - 0.07, -L, 0.002), (x + 0.07, -L, 0.002), (x + 0.07, L, 0.002), (x - 0.07, L, 0.002)], 'line')
    return m.build()


def render(sid, cfg):
    sc = bpy.context.scene
    field_proxy()
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 32
    sc.render.resolution_x, sc.render.resolution_y = 800, 450
    sc.render.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    hs = S.rgb(cfg['sky'])
    bg.inputs['Color'].default_value = (*hs, 1)
    bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = cfg['sun'][1] * 1.3
    sun.data.color = S.rgb(cfg['sun'][0])
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = cfg.get('lens', 22)
    cam.data.clip_end = cfg.get('clip', 600)
    sc.collection.objects.link(cam)
    sc.camera = cam
    eye, target = cfg['cam']
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    os.makedirs(CONCEPTS, exist_ok=True)
    sc.render.filepath = os.path.join(CONCEPTS, sid + '.png')
    bpy.ops.render.render(write_still=True)
    # a small JPEG for the in-game inventory
    img = bpy.data.images['Render Result']
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 80
    img.save_render(os.path.join(OUT, sid, 'preview.jpg'), scene=sc)


def main():
    names = [a for a in args if not a.startswith('--')] or list(STADIUMS)
    for sid in names:
        build, label, pitch = STADIUMS[sid]
        bpy.ops.wm.read_factory_settings(use_empty=True)
        m = Mesh(sid)
        os.makedirs(os.path.join(OUT, sid), exist_ok=True)
        cfg = build(m)
        tris = len(m.bm.faces)
        if '--stats' in args:  # loops per material: where the file size goes
            per = {}
            for f in m.bm.faces:
                per[m.mats[f.material_index].name] = per.get(m.mats[f.material_index].name, 0) + len(f.loops)
            print(sorted(per.items(), key=lambda kv: -kv[1]))
        ob = m.build()
        textured = m.textured
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        path = os.path.join(OUT, sid, sid + '.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, use_selection=True, export_texcoords=textured,
                                  export_normals=True, export_animations=False, export_extras=False, export_yup=True,
                                  export_image_format='AUTO')
        size = os.path.getsize(path)
        info = dict(label=label, pitch=pitch, scene=dict(sky=cfg['sky'], fog=cfg['fog'], hemi=cfg['hemi'], sun=cfg['sun']))
        with open(os.path.join(OUT, sid, 'info.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(info, f, indent=1)
            f.write('\n')
        print(f'STADIUM {sid}: {tris} faces, {size / 1024:.1f} KB')
        if '--no-render' not in args:
            render(sid, cfg)
    print('DONE')


main()
