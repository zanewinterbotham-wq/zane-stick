"""Dolphin Hills Stadium (built by stadium.py: build(m, st), st = the stadium.py module for its shared pieces).

A coastal high-school stadium set down in a bowl: the field and a red 400 m track at the bottom, the big home
grandstand built into the far slope with a press box on top, the baseball and softball fields and the school on the
upper level, the snack bar, restrooms and a sand seating area on a terrace beside the stand, a parking lot with solar
carports on the near side, a green hillside on the right and the Pacific right behind it all. No houses.

World frame as in stadium_lib: X across the field (near side -X, the home side +X), Y along it, Z up.
"""
import math
import random

import bpy

import stadium_lib as S
from stadium_lib import HX, HY

C, RI = 48.0, 33.0
RO = RI + 8 * 1.22               # outer edge of lane 8
N = 12                           # segments per half circle of the track family
YD = 0.9144
BOWL_X, BOWL_Y = 46.0, 95.0      # the bowl floor (field, track, walkway) is flat inside this rectangle
UP = 12.5                        # the upper level behind the home stand
SEA = -3.0


def sm(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def shore(y):
    """x of the waterline: the coast bends toward the near side on the school's end, away on the hillside's."""
    return 180 - 0.55 * max(0.0, y - 110) + 0.3 * max(0.0, -y - 110)


def shore_s(x):
    """y of the waterline past the south (scoreboard) end: the coast turns the corner and runs behind it, bending away
    south past the parking lot where the hillside rises."""
    return -150 - 0.7 * max(0.0, -x - 60)


def seaward(x, y):
    """Signed distance past the waterline (positive in the sea), the two coasts joined by a rounded corner."""
    a, b = x - shore(y), shore_s(x) - y
    return (a + b + math.sqrt((a - b) ** 2 + 30 ** 2)) / 2


PADS = [(46, 80, -92, -36, 1.0, 6.0)]  # the snack-bar terrace: x0 x1 y0 y1, height, blend margin


def H(x, y):
    """Ground height. The bowl floor sits a little under the game's field plane (z 0)."""
    if abs(x) <= BOWL_X and abs(y) <= BOWL_Y:
        return -0.08
    h = max(UP * min(1.0, max(0.0, (x - BOWL_X) / 22)),       # far side: the slope the home stand is built into
            2.2 * sm((-x - BOWL_X) / 6),                       # near side: up to the parking lot
            5.5 * sm((y - BOWL_Y) / 13),                       # the school terrace
            20 * sm((-y - BOWL_Y) / 80) * sm((-x - 40) / 60),  # the green hillside past the south-west corner
            16 * sm((-x - 130) / 110))                         # inland hills beyond the parking lot
    for x0, x1, y0, y1, z, mg in PADS:
        d = max(x0 - x, x - x1, y0 - y, y - y1, 0.0)
        h = z + (h - z) * sm(d / mg)
    d = seaward(x, y)                                          # the bluff, the beach and the sea floor
    if d > -16:
        h += (-2.4 - h) * sm((d + 16) / 13)
    if d > 8:
        h += (-7 - h) * sm((d - 8) / 10)
    return h - 0.08


# ---------------------------------------------------------------- small helpers --------------------------------------
def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def qf(m, pts, mat, n=(0, 0, 1)):
    """A face turned to look along n."""
    if dot(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])), n) < 0:
        pts = pts[::-1]
    m.quad(pts, mat)


def flat(m, poly, z, mat):
    """Flat polygon (x, y points) at height z, facing up."""
    qf(m, [(x, y, z) for x, y in poly], mat)


def rect(m, x0, y0, x1, y1, z, mat):
    flat(m, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z, mat)


def circle(cx, cy, r, n=10, a0=0.0, a1=2 * math.pi):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + (0 if a1 - a0 >= 2 * math.pi - 1e-6 else 1))]


def annulus(m, cx, cy, r0, r1, z, mat, n=12):
    a, b = circle(cx, cy, r0, n), circle(cx, cy, r1, n)
    for i in range(n):
        j = (i + 1) % n
        flat(m, [a[i], b[i], b[j], a[j]], z, mat)


def box_on(m, x, y, sx, sy, h, mat, rot=0.0, z=None, sink=0.8):
    """Box standing on the ground (or on z), sunk a little so slopes never show a gap underneath."""
    zb = H(x, y) if z is None else z
    m.box(x, y, zb + (h - sink) / 2, sx, sy, h + sink, mat, rot=rot)


def strip(m, x0, y0, x1, y1, w, z, mat):
    """Thin flat line from (x0, y0) to (x1, y1)."""
    L = math.hypot(x1 - x0, y1 - y0)
    nx, ny = -(y1 - y0) / L * w / 2, (x1 - x0) / L * w / 2
    flat(m, [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], z, mat)


def pieces(pts, step):
    """Split a polyline into pieces no longer than step (so things laid on it can follow the ground)."""
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
        out += [((x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n), (x0 + (x1 - x0) * (i + 1) / n, y0 + (y1 - y0) * (i + 1) / n)) for i in range(n)]
    return out


def drape(m, pts, w, mat, lift=0.07, step=6.0):
    """A path laid on the ground along a polyline."""
    for (x0, y0), (x1, y1) in pieces(pts, step):
        L = math.hypot(x1 - x0, y1 - y0)
        nx, ny = -(y1 - y0) / L * w / 2, (x1 - x0) / L * w / 2
        ps = [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)]
        qf(m, [(x, y, H(x, y) + lift) for x, y in ps], mat)


def hedge(m, pts, w, h, mat='hedge', step=7.0):
    """A clipped hedge row along a polyline: one flat-topped block per piece."""
    for (x0, y0), (x1, y1) in pieces(pts, step):
        xm, ym = (x0 + x1) / 2, (y0 + y1) / 2
        zb = min(H(x0, y0), H(x1, y1), H(xm, ym))
        top = max(H(x0, y0), H(x1, y1), H(xm, ym)) + h
        m.box(xm, ym, (zb - 0.3 + top) / 2, math.hypot(x1 - x0, y1 - y0) + 0.4, w, top - zb + 0.3, mat, rot=math.atan2(y1 - y0, x1 - x0),
              skip=('bot', 'lo_u', 'hi_u'))  # the pieces' ends touch: no end faces


def blob(m, x, y, z, r, h, mat, sides=6, rnd=None):
    """Smooth low-poly clump (bush, tree crown): a base ring, a narrower middle ring and a top, shared vertices."""
    a0 = (rnd.random() if rnd else 0.0) * 6.28
    v = [(x + r * math.cos(a0 + 2 * math.pi * i / sides), y + r * math.sin(a0 + 2 * math.pi * i / sides), z) for i in range(sides)]
    v += [(x + 0.8 * r * math.cos(a0 + 2 * math.pi * (i + 0.5) / sides), y + 0.8 * r * math.sin(a0 + 2 * math.pi * (i + 0.5) / sides), z + 0.55 * h) for i in range(sides)]
    v.append((x, y, z + h))
    f = []
    for i in range(sides):
        j = (i + 1) % sides
        f += [(i, j, sides + i), (sides + i, j, sides + j), (sides + i, sides + j, 2 * sides)]
    c = (x, y, z + 0.35 * h)
    out = []
    for t in f:
        p = [v[k] for k in t]
        cen = tuple(sum(q[k] for q in p) / 3 for k in range(3))
        out.append(t if dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), sub(cen, c)) > 0 else t[::-1])
    m.shared(v, out, mat)


def post(m, x, y, z0, z1, r, mat, sides=4, r1=None):
    """Pole, post or trunk: an open prism over shared, smooth-shaded vertices (half the size of a faceted one)."""
    r1 = r if r1 is None else r1
    v = [(x + rr * math.cos(2 * math.pi * i / sides), y + rr * math.sin(2 * math.pi * i / sides), z) for z, rr in ((z0, r), (z1, r1)) for i in range(sides)]
    m.shared(v, [(i, (i + 1) % sides, sides + (i + 1) % sides, sides + i) for i in range(sides)], mat)


def bush(m, x, y, s, mat, rnd):
    blob(m, x, y, H(x, y) - 0.25, 1.2 * s, 1.5 * s, mat, 5, rnd)


def tree(m, x, y, s, rnd, mat=None):
    zb = H(x, y)
    post(m, x, y, zb - 0.4, zb + 2.6 * s, 0.26 * s, 'trunk', 3, 0.18 * s)
    blob(m, x, y, zb + 1.8 * s, 2.5 * s * rnd.uniform(0.85, 1.15), 4.4 * s, mat or rnd.choice(('leaf', 'hedge', 'bush')), 6, rnd)


def palm(m, x, y, s, rnd):
    zb = H(x, y)
    top = zb + 9.0 * s
    post(m, x, y, zb - 0.4, top, 0.32 * s, 'palm_t', 3, 0.2 * s)
    a0 = rnd.random() * 6.28
    for i in range(5):  # drooping fronds: a thin triangle from the crown, tip below it
        a = a0 + i * 2 * math.pi / 5
        ca, sa = math.cos(a), math.sin(a)
        L = 3.8 * s * rnd.uniform(0.85, 1.15)
        m.tri([(x - 0.35 * sa * s, y + 0.35 * ca * s, top + 0.25), (x + 0.35 * sa * s, y - 0.35 * ca * s, top + 0.25), (x + ca * L, y + sa * L, top - 1.8 * s)], 'frond')


_TEXT = {}


def text_geo(body, bold):
    """Blender's built-in font turned into flat triangles (x, y in font units)."""
    key = (body, bold)
    if key not in _TEXT:
        cu = bpy.data.curves.new('txt', 'FONT')
        cu.body = body
        cu.size = 1.0
        cu.resolution_u = 1
        cu.offset = bold
        ob = bpy.data.objects.new('txt', cu)
        bpy.context.scene.collection.objects.link(ob)
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        _TEXT[key] = ([(v.co.x, v.co.y) for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    return _TEXT[key]


def text(m, body, o, d, u, w, h, mat, bold=0.03, fit=None):
    """Lettering centred on o, running along d with its tops toward u (d x u is the side it faces), fitted into
    w x h metres. Returns the fit (scale, centre) so an outline can be laid under it exactly."""
    vs, fs = text_geo(body, bold)
    if fit is None:
        xs, ys = [p[0] for p in vs], [p[1] for p in vs]
        s = min(w / (max(xs) - min(xs)), h / (max(ys) - min(ys)))
        fit = (s, (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2)
    s, cx, cy = fit
    pts = [tuple(o[k] + (px - cx) * s * d[k] + (py - cy) * s * u[k] for k in range(3)) for px, py in vs]
    m.shared(pts, fs, mat, smooth=False)
    return fit


# ---------------------------------------------------------------- the pieces -----------------------------------------
def terrain(m, rnd):
    xs = sorted({-1500, -700, -450, -330, -260, -210, -175, -150, -130, -118, -105, -92, -80, -68, -56, -52, -49, -BOWL_X,
                 BOWL_X, 48, 51, 55, 59, 64, 68, 74, 80, 86, *range(95, 240, 10), 260, 300, 400, 700, 1500})
    ys = sorted({-1500, -700, -450, -330, -270, -230, -200, -175, -158, -147, -134, -125, -112, -103, -BOWL_Y, -92, -86,
                 -36, -31, 31, 88, BOWL_Y, 99, 103, 108, 114, 125,
                 140, 160, 185, 215, 250, 300, 400, 700, 1500})
    verts = [(x, y, H(x, y)) for y in ys for x in xs]
    nx = len(xs)
    faces, mats = [], []
    for j in range(len(ys) - 1):
        for i in range(nx - 1):
            faces.append((j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i))
            cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
            d = seaward(cx, cy)
            if d > -3:
                mats.append('sand')
            elif d > -17 and H(cx, cy) < UP - 0.5:
                mats.append('bluff')
            elif BOWL_X < cx < 68 and (31 < cy < 90 or -40 < cy < -30):
                mats.append('dirt')                 # bare earth either side of the home stand
            elif cy < -100 and cx < -40:   # small cells only: a wide one would paint a stripe across the hill
                mats.append('dirt' if rnd.random() < 0.15 and (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) < 500 else 'scrub')   # the hillside: scrub with bare patches
            elif cx > 68 or cy > 108 or cx < -53:
                mats.append('lawn2')                # the upper levels: a little drier
            else:
                mats.append('lawn')
    m.shared(verts, faces, mats)


def sea(m, rnd):
    flat(m, [(-2500, -2500), (2500, -2500), (2500, 2500), (-2500, 2500)], SEA, 'sea')
    for y in range(-130, 420, 30):  # shallow water, then broken lines of surf parallel to the beaches
        y1 = y + 30
        flat(m, [(shore(y) + 6, y), (shore(y) + 34, y), (shore(y1) + 34, y1), (shore(y1) + 6, y1)], SEA + 0.01, 'sea_s')
        for off, w in ((9, 1.4), (16, 0.9), (30, 0.7))[:3 if y % 60 == 0 else 2]:
            a = rnd.uniform(0, 8)
            b = rnd.uniform(18, 30)
            strip(m, shore(y + a) + off, y + a, shore(y + b) + off, y + b, w, SEA + 0.02, 'foam')
    for x in range(-420, 150, 30):  # and round the corner, past the south end
        x1 = x + 30
        flat(m, [(x, shore_s(x) - 6), (x, shore_s(x) - 34), (x1, shore_s(x1) - 34), (x1, shore_s(x1) - 6)], SEA + 0.01, 'sea_s')
        for off, w in ((9, 1.4), (16, 0.9), (30, 0.7))[:3 if x % 60 == 0 else 2]:
            a, b = rnd.uniform(0, 8), rnd.uniform(18, 30)
            strip(m, x + a, shore_s(x + a) - off, x + b, shore_s(x + b) - off, w, SEA + 0.02, 'foam')
    for x, y, s in ((420, -60, 1.0), (560, 140, 1.4), (300, 260, 0.8), (-60, -360, 1.2), (150, -300, 0.9)):  # a few sailboats
        m.tri([(x, y, SEA), (x, y + 6 * s, SEA), (x, y + 0.5 * s, SEA + 9 * s)], 'white')
    # a lifeguard tower on the beach
    for lx, ly in ((shore(-30) + 3, -30), (40, shore_s(40) - 3)):
        for dx in (-1, 1):
            for dy in (-1, 1):
                m.box(lx + dx, ly + dy, SEA + 2.2, 0.15, 0.15, 3.6, 'white')
        m.box(lx, ly, SEA + 4.6, 2.8, 2.8, 2.0, 'blue')
        m.box(lx, ly, SEA + 5.75, 3.4, 3.4, 0.3, 'white')


def field_paint(m):
    """Blue end zones, their lettering and the midfield DH, a hair above the game's own field (whose lines show round
    them). The game lifts the *_decalN materials with a polygon offset (N = layer), so they never flicker."""
    ex, y0, y1 = S.SIDELINE - 0.08, 50 * YD + 0.06, 60 * YD - 0.08
    for sg in (1, -1):
        rect(m, -ex, sg * y0, ex, sg * y1, 0.02, 'ez_decal1')
    yc = 55 * YD
    text(m, 'DOLPHINS', (0, yc, 0.035), (1, 0, 0), (0, 1, 0), 38, 5.0, 'paint_decal2', 0.04)
    text(m, 'DOLPHIN HILLS', (0, -yc, 0.035), (-1, 0, 0), (0, -1, 0), 44, 4.6, 'paint_decal2', 0.04)
    text(m, 'DH', (0, 0, 0.02), (0, -1, 0), (1, 0, 0), 10.5, 5.6, 'ez_decal1', 0.05)

def track(m, st):
    m.oval_fill(RI, C, -0.056, 'track', n=N)                        # the D areas at both ends are track surface
    rect(m, -RI + 0.4, -(60 * YD + 7.5), RI - 0.4, 60 * YD + 7.5, -0.05, 'apron')
    m.oval(RI, RO, C, -0.05, -0.04, 'track', ('top',), n=N)
    for i in range(9):
        r = RI + i * 1.22
        m.oval(r - 0.04, r + 0.04, C, -0.045, -0.035, 'line', ('top',), n=N)
    for y in (-20.0, 6.0, 30.0):  # start and finish lines on the home straight
        rect(m, RI, y - 0.06, RO, y + 0.06, -0.034, 'line')
    for i in range(8):            # staggered 400 m starts on the near straight
        x = -(RI + 0.61 + i * 1.22)
        rect(m, x - 0.55, 20 - i * 3.6 - 0.06, x + 0.55, 20 - i * 3.6 + 0.06, -0.034, 'line')
    m.oval(RO + 0.6, RO + 3.0, C, -0.05, -0.045, 'concrete', ('top',), n=N)       # walkway round the track
    m.oval(RO + 0.25, RO + 0.5, C, -0.05, 0.45, 'concrete', ('top', 'inner'), n=N)  # curb
    # field-event areas in the Ds: long-jump runways and pits, shot-put circle and sector, discus cage, high jump
    for y, x0, x1 in ((69.5, -22, 8), (74.0, -17, 5)):
        rect(m, x0, y - 0.6, x1, y + 0.6, -0.03, 'runway')
        rect(m, x1 + 1, y - 1.5, x1 + 9, y + 1.5, -0.025, 'sand')
        m.box(x1 + 0.6, y, -0.02, 0.2, 1.2, 0.04, 'white')
    annulus(m, -12, -68, 1.02, 1.1, -0.03, 'line')
    for a in (-0.3, 0.3):
        strip(m, -12, -68, -12 + 16 * math.sin(a), -68 + 16 * math.cos(a), 0.08, -0.03, 'line')
    annulus(m, 10, -70, 1.2, 1.3, -0.03, 'line')
    for i in range(8):  # discus cage: poles on a C and a rail round the top
        a = math.pi * (0.75 + 1.5 * i / 7) - math.pi / 2
        post(m, 10 + 3.2 * math.cos(a), -70 + 3.2 * math.sin(a), 0, 4.2, 0.06, 'pole', 4)
    for i in range(7):
        a, b = (math.pi * (0.75 + 1.5 * k / 7) - math.pi / 2 for k in (i, i + 1))
        m.box(10 + 3.2 * math.cos((a + b) / 2), -70 + 3.2 * math.sin((a + b) / 2), 4.1, 0.08, 2.6, 0.08, 'pole', rot=(a + b) / 2)
    m.box(0, -78, 0.35, 6, 4, 0.7, 'blue')                         # high-jump mat with its standards
    for x in (-2.2, 2.2):
        m.box(x, -80.3, 1.2, 0.1, 0.1, 2.4, 'pole')
    # portable bleachers and a stack of hurdles on the track Ds, a small soccer goal
    for x, y, rot, rows in ((-20, 64, 0.55, 4), (18, -64, -0.4, 3), (22, -72, -0.6, 3)):
        ca, sa = math.cos(rot), math.sin(rot)
        for k in range(rows):
            m.box(x - sa * k * 0.7, y + ca * k * 0.7, 0.35 + k * 0.35, 9, 0.6, 0.12, 'alu', rot=rot)
    for i in range(2):
        m.box(-25 + i * 0.3, -60, 0.45, 0.06, 1.2, 0.9, 'white')
    for x in (-3.6, 3.6):
        m.box(x, 80, 1.0, 0.1, 0.1, 2.0, 'white')
    m.box(0, 80, 2.0, 7.3, 0.1, 0.1, 'white')
    # the padded wall on the physics barrier, goalposts over the end walls, team benches between wall and track
    m.ring(0, 0.5, 0, 1.2, 'line', ('top', 'inner', 'outer'), inner_mat='blue')   # plain blue pads, white cap
    for sg in (1, -1):
        yb = sg * (HY + 2.4)
        post(m, 0, yb, 0, 3.05, 0.16, 'goal', 6)
        m.box(0, yb, 1.0, 0.6, 0.6, 2.0, 'blue')
        m.box(0, sg * (HY + 1.3), 3.05, 0.2, 2.4, 0.2, 'goal')
        m.box(0, sg * (HY + 0.2), 3.05, 7.11, 0.2, 0.2, 'goal')
        for x in (-3.555, 3.555):
            m.box(x, sg * (HY + 0.2), 6.1, 0.15, 0.15, 6.1, 'goal')
        m.box(0, sg * (HY + 0.2), 9.25, 0.3, 0.05, 0.6, 'orange')
    for sx in (1, -1):
        for y in (-13, 0, 13):
            m.box(sx * 31.4, y, 0.25, 0.45, 9, 0.5, 'blue' if sx > 0 else 'alu')
        m.cyl(sx * 31.3, 20, 0, 0.9, 0.3, 'orange', 6)
        m.box(sx * 31.3, 22, 0.4, 0.7, 1.2, 0.8, 'white')
    # chain-link posts and rails on the curb round the track
    pts = m.oval_pts(RO + 0.38, C, N)
    for x, y in pts[::2] + [(sx * (RO + 0.38), y) for y in range(-36, 37, 12) for sx in (-1, 1)]:
        post(m, x, y, 0.4, 1.58, 0.05, 'pole', 3)
    m.oval(RO + 0.33, RO + 0.43, C, 1.5, 1.58, 'pole', ('top',), n=N)


RISER = {'seat': 'seat_d', 'seat_l': 'seat', 'concrete': 'concrete_d'}  # the riser under each kind of row


def section_steps(m, x0, sgn, segs, rows, run, rise, z0, riser):
    """Raked seating: rows going away from the field along sgn*x; segs = [(y0, y1, material per row)]."""
    z = -0.04
    for k in range(rows):
        xa, xb = x0 + sgn * k * run, x0 + sgn * (k + 1) * run
        zt = z0 + k * rise
        for y0, y1, mf in segs:
            qf(m, [(xa, y0, z), (xa, y1, z), (xa, y1, zt), (xa, y0, zt)], RISER.get(mf(k), riser), (-sgn, 0, 0))
            qf(m, [(xa, y0, zt), (xb, y0, zt), (xb, y1, zt), (xa, y1, zt)], mf(k))
        z = zt
    return x0 + sgn * rows * run, z


def side_wall(m, x0, x1, y, z0, z1, mat, t=0.3):
    """Concrete end wall of a stand: a trapezoid from the ground up past the rows, both faces."""
    for yy, n in ((y - t / 2, -1), (y + t / 2, 1)):
        qf(m, [(x0, yy, -1.0), (x0, yy, z0 + 0.9), (x1, yy, z1 + 0.9), (x1, yy, H(x1, yy) - 1.0)], mat, (0, n, 0))
    qf(m, [(x0, y - t / 2, z0 + 0.9), (x0, y + t / 2, z0 + 0.9), (x1, y + t / 2, z1 + 0.9), (x1, y - t / 2, z1 + 0.9)], mat)


def home_stand(m):
    x0 = RO + 1.85
    rows, run, rise, z0 = 28, 0.85, 0.445, 0.4
    lite = lambda k: 'seat_l' if k < 11 else 'seat'          # noqa: E731  the lighter lower-middle block
    segs = [(-31.1, -12.1, lambda k: 'seat'), (-9.5, -4.0, lambda k: 'seat'), (-4.0, 4.0, lite), (4.0, 9.5, lambda k: 'seat'), (12.1, 31.1, lambda k: 'seat')]
    xe, ze = section_steps(m, x0, 1, segs, rows, run, rise, z0, 'concrete_d')
    for y0, y1 in ((-12.1, -9.5), (9.5, 12.1)):   # the aisles: plain concrete ramps between the sections
        qf(m, [(x0, y0, -0.04), (x0, y1, -0.04), (xe, y1, ze - rise / 2), (xe, y0, ze - rise / 2)], 'concrete', (-1, 0, 1))
    for y in (-31.1, 31.1):
        side_wall(m, x0, xe, y, z0, ze, 'concrete')
    for y in (-12.1, -9.5, 9.5, 12.1):      # hand rails down the aisles
        m.box((x0 + xe) / 2, y, (z0 + ze) / 2 + 1.0, math.hypot(xe - x0, ze - z0), 0.06, 0.06, 'pole', rot=0)
    m.box(x0 - 0.05, 0, 0.55, 0.1, 62.4, 1.1, 'blue')        # padded front wall with a rail on top
    # concourse along the top and the press box, centred and big
    zc = ze
    m.box(xe + 2.3, 0, zc - 1.5, 4.6, 64, 3.0, 'concrete')
    m.box(xe + 0.05, 0, zc + 0.55, 0.06, 62.2, 0.06, 'pole')
    px0, px1, py = xe + 0.3, xe + 9.3, 19.0
    m.box((px0 + px1) / 2, 0, zc + 1.6, px1 - px0, 2 * py, 3.2, 'stucco')
    for y in (-14, -7, 7, 14):
        m.box(px0 - 0.03, y, zc + 1.1, 0.06, 1.2, 2.2, 'navy')
    m.box((px0 + px1) / 2 - 0.3, 0, zc + 3.35, px1 - px0 + 0.6, 2 * py + 0.6, 0.3, 'blue')
    text(m, 'DOLPHIN HILLS', (px0 - 0.32, 0, zc + 3.35), (0, 1, 0), (0, 0, 1), 18, 0.24, 'white', 0.02)
    m.box((px0 + px1) / 2 + 0.4, 0, zc + 5.0, px1 - px0 - 0.8, 2 * py - 1, 3.0, 'white')
    m.box(px0 + 0.38, 0, zc + 5.0, 0.06, 2 * py - 2, 2.0, 'glass')
    for y in range(-16, 17, 8):
        m.box(px0 + 0.36, y, zc + 5.0, 0.1, 0.2, 2.0, 'white', skip=('bot', 'top', 'hi_v'))
    m.box((px0 + px1) / 2, 0, zc + 6.7, px1 - px0 + 1.4, 2 * py + 1.4, 0.4, 'blue')
    for y in (-10, 10):  # rooftop camera huts and a rail
        m.box(px0 + 3, y, zc + 7.9, 3, 4, 2.0, 'white')
        m.box(px0 + 3, y, zc + 9.0, 3.4, 4.4, 0.2, 'navy')
    m.box(px0 + 0.6, 0, zc + 7.4, 0.06, 2 * py, 0.06, 'pole')
    post(m, px1 - 1.5, 15, zc + 6.9, zc + 13, 0.06, 'pole', 4)
    # stairs up both ends of the stand to the concourse
    for y in (-33.2, 33.2):
        qf(m, [(x0, y - 1.6, -0.03), (x0, y + 1.6, -0.03), (xe, y + 1.6, ze), (xe, y - 1.6, ze)], 'concrete')
        m.box((x0 + xe) / 2, y + (1.6 if y > 0 else -1.6), ze / 2 + 0.9, math.hypot(xe - x0, ze), 0.05, 0.05, 'pole',
              rot=0)
    return xe, ze


def visitor_stand(m):
    x0 = -(RO + 1.85)
    xe, ze = section_steps(m, x0, -1, [(-15, 15, lambda k: 'alu')], 8, 0.8, 0.45, 0.35, 'alu_d')
    for y in (-15, 15):
        side_wall(m, xe, x0, y, ze, 0.35, 'alu_d', t=0.12)
    m.box(xe - 0.05, 0, ze + 0.55, 0.06, 30, 0.06, 'pole')
    for y in (-15, 15):
        m.box(xe - 0.05, y, ze + 0.3, 0.06, 0.06, 0.6, 'pole')


def snack_terrace(m, rnd):
    z = H(60, -60)
    m.box(BOWL_X + 0.15, -64, z / 2 - 0.1, 0.3, 56, z + 0.2, 'concrete')        # retaining wall along the walkway
    for k in range(5):                                                          # steps up from the track
        m.box(BOWL_X - 1.2 + k * 0.3, -40.5, (k + 1) * z / 5 / 2, 0.3, 3, (k + 1) * z / 5, 'concrete')

    def hut(x, y, sx, sy, h, wall, label=None, doors=0):
        box_on(m, x, y, sx, sy, h, wall, z=z)
        m.box(x, y, z + h + 0.15, sx + 1.2, sy + 1.2, 0.3, 'blue')
        if label:
            text(m, label, (x - sx / 2 - 0.62, y, z + h + 0.15), (0, 1, 0), (0, 0, 1), sy - 1, 0.24, 'white', 0.02)
        for i in range(doors):
            m.box(x - sx / 2 - 0.03, y - sy / 2 + (i + 0.5) * sy / doors, z + 1.05, 0.06, 1.0, 2.1, 'navy')

    hut(53, -44, 6, 11, 3.2, 'white', 'SNACK BAR')
    m.box(49.9, -44, z + 1.5, 0.08, 7, 1.0, 'win')                              # serving window, awning, counter
    m.box(49.4, -44, z + 2.45, 1.2, 8, 0.12, 'blue')
    m.box(49.8, -44, z + 1.0, 0.5, 7.5, 0.1, 'white')
    hut(53, -56, 6, 9, 3.0, 'stucco2', 'RESTROOMS', doors=2)
    hut(67, -42, 6, 8, 2.8, 'white')                                             # storage
    hut(64, -52, 3, 3, 2.4, 'stucco2')                                           # ticket / equipment shed
    # the sand area: picnic tables, benches, umbrellas, palms, trash cans
    sand = [(50, -64), (76, -64), (78, -76), (72, -88), (52, -88)]
    flat(m, sand, z + 0.03, 'sand')
    for i in range(len(sand)):
        a, b = sand[i], sand[(i + 1) % len(sand)]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        m.box((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z + 0.12, L, 0.3, 0.3, 'concrete', rot=math.atan2(b[1] - a[1], b[0] - a[0]))
    for i, (x, y) in enumerate([(56, -69), (63, -69), (70, -70), (56, -77), (63, -77), (66, -84)]):
        m.box(x, y, z + 0.75, 1.0, 2.2, 0.08, 'blue' if i % 2 else 'white')
        for dx in (-0.8, 0.8):
            m.box(x + dx, y, z + 0.45, 0.35, 2.2, 0.06, 'alu')
        if i % 3 == 0:
            post(m, x, y, z + 0.7, z + 2.6, 0.04, 'pole', 4)
            m.cyl(x, y, z + 2.2, z + 2.9, 1.6, 'blue' if i % 2 == 0 else 'orange', 6, 0)
    for y in (-66, -72, -78, -84):
        m.box(75, y, z + 0.45, 0.45, 2.4, 0.08, 'alu')
    for x, y in ((51, -62), (76, -66), (74, -86), (50, -50)):
        palm(m, x, y, rnd.uniform(0.9, 1.1), rnd)
    for x, y in ((51, -66), (59, -63), (70, -64), (51, -38)):
        post(m, x, y, z, z + 1.0, 0.33, 'navy', 5)


def scoreboard(m):
    """Centred behind the south end, low and big, facing up the field."""
    y, w, h, zb = -(C + RO) - 5.5, 18.0, 8.0, 2.2
    for x in (-6, 6):
        m.box(x, y - 0.3, zb / 2 - 0.5, 0.7, 0.7, zb + 1.0, 'steel_d')
    m.box(0, y - 0.3, zb + h / 2, w, 0.9, h, 'board')
    m.box(0, y + 0.18, zb + h - 1.1, w - 0.6, 0.1, 1.8, 'blue')
    text(m, 'DOLPHINS', (0, y + 0.25, zb + h - 1.1), (-1, 0, 0), (0, 0, 1), 11, 1.3, 'white', 0.03)
    m.box(0, y + 0.17, zb + 2.9, w - 1.2, 0.1, 4.6, 'face')
    # changeable name strips: each team on its own framed insert plate; +X is the left side seen from the field
    for lab, x, col in (('DOLPHINS', 5.0, 'blue'), ('LAGUNA BEACH', -5.0, 'apron')):
        m.box(x, y + 0.25, zb + 4.45, 6.4, 0.1, 1.3, 'alu')
        m.box(x, y + 0.31, zb + 4.45, 6.0, 0.06, 1.0, col)
        text(m, lab, (x, y + 0.35, zb + 4.45), (-1, 0, 0), (0, 0, 1), 5.6, 0.72, 'white', 0.02)
    for num, x in (('31', 5.0), ('7', -5.0)):
        text(m, num, (x, y + 0.24, zb + 2.5), (-1, 0, 0), (0, 0, 1), 3.0, 1.9, 'lit', 0.02)
    text(m, '12:00', (0, y + 0.24, zb + 3.6), (-1, 0, 0), (0, 0, 1), 3.2, 1.0, 'lit', 0.02)


def near_side(m, st, rnd):
    zp = H(-80, 0)
    # the parking lot: asphalt, stall lines, arrows, solar carports, light poles and cars
    rect(m, -118, -84, -54.5, 88, zp + 0.03, 'asphalt')
    bays = [(-56, -61.5), (-68, -73.5), (-73.5, -79), (-86, -91.5), (-91.5, -97), (-104, -109.5)]
    zl = zp + 0.05
    stalls = []
    for xa, xb in bays:
        for i in range(60):
            y = -80 + 2.8 * i
            if y > 85:
                break
            if xa <= -86 and y > 22:   # hidden under the carports
                continue
            rect(m, min(xa, xb), y - 0.06, max(xa, xb), y + 0.06, zl, 'line')
            stalls.append(((xa + xb) / 2, y + 1.4))
    for x in (-73.5, -91.5):
        rect(m, x - 0.06, -80, x + 0.06, 85, zl, 'line')
    for x, y, sg in ((-64.75, -40, 1), (-64.75, 30, -1), (-82.5, 0, 1), (-100.5, -50, -1), (-100.5, 20, 1)):  # arrows
        flat(m, [(x - 0.4, y), (x + 0.4, y), (x + 0.4, y + 2.2 * sg), (x - 0.4, y + 2.2 * sg)], zl, 'line')
        flat(m, [(x - 1.1, y + 2.2 * sg), (x + 1.1, y + 2.2 * sg), (x, y + 3.6 * sg)], zl, 'line')
    for xa, xb in ((-86, -97), (-104, -110)):           # solar carports over the left end of two rows
        xm = (xa + xb) / 2
        for y in (24, 44, 64, 84):
            post(m, xm, y, zp, zp + 4.3, 0.18, 'pole', 4)
        qf(m, [(xa, 22, zp + 4.1), (xb, 22, zp + 5.0), (xb, 86, zp + 5.0), (xa, 86, zp + 4.1)], 'solar')
        for k in range(1, 4):
            y = 22 + k * 16
            qf(m, [(xa, y - 0.08, zp + 4.13), (xb, y - 0.08, zp + 5.03), (xb, y + 0.08, zp + 5.03), (xa, y + 0.08, zp + 4.13)], 'alu')
    for x in (-64.75, -82.5, -100.5):
        for y in (-45, 5, 55):
            post(m, x, y, zp, zp + 10, 0.13, 'pole', 4, 0.08)
            m.box(x, y, zp + 10, 0.5, 2.4, 0.25, 'steel_d')
    cols = ['white', 'alu', 'steel_d', 'track', 'navy', 'white', 'board', 'stucco2']
    for (x, y) in rnd.sample(stalls, 16):
        m.box(x, y, zp + 0.65, 4.4, 1.8, 0.8, rnd.choice(cols))
        m.box(x + 0.2, y, zp + 1.3, 2.3, 1.62, 0.55, 'win', skip=('bot', 'lo_u', 'hi_u'))
    m.box(-95, -40, zp + 1.0, 6.5, 2.4, 1.5, 'white')                          # a van and the campus buggy
    # blue padded fence with the school's name along the top of the near slope, an entry gate, ticket booth, flag
    xf = -53.2
    for y0, y1 in ((-86, -61), (-53, 88)):
        n = max(1, int((y1 - y0) // 8))
        for i in range(n + 1):
            post(m, xf, y0 + (y1 - y0) * i / n, zp - 0.2, zp + 1.95, 0.05, 'pole', 3)
        m.box(xf, (y0 + y1) / 2, zp + 1.05, 0.05, y1 - y0, 1.5, 'blue')
        m.box(xf, (y0 + y1) / 2, zp + 1.9, 0.08, y1 - y0, 0.06, 'pole')
    text(m, 'DOLPHIN HILLS HIGH SCHOOL', (xf + 0.04, 52, zp + 1.05), (0, 1, 0), (0, 0, 1), 54, 0.95, 'white', 0.02)
    text(m, 'HOME OF THE DOLPHINS', (xf - 0.04, 22, zp + 1.05), (0, -1, 0), (0, 0, 1), 46, 0.95, 'white', 0.02)
    for y in (-61, -53):
        m.box(xf, y, zp + 2.0, 0.5, 0.5, 4.0, 'stucco2')
    m.box(xf, -57, zp + 4.3, 0.6, 9.2, 1.0, 'blue')
    text(m, 'DOLPHINS', (xf - 0.32, -57, zp + 4.3), (0, -1, 0), (0, 0, 1), 7, 0.75, 'white', 0.03)
    rect(m, -58, -64, xf, -50, zp + 0.06, 'concrete')
    box_on(m, -57.5, -66.5, 3, 3, 2.8, 'white')                                  # ticket booth
    m.box(-57.5, -66.5, H(-57.5, -66.5) + 2.95, 3.8, 3.8, 0.3, 'blue')
    m.box(-56.0, -66.5, H(-57.5, -66.5) + 1.5, 0.08, 1.6, 0.9, 'win')
    text(m, 'TICKETS', (-55.95, -66.5, H(-57.5, -66.5) + 2.3), (0, 1, 0), (0, 0, 1), 2.2, 0.4, 'navy', 0.02)
    fx, fy = -57.5, -47.5
    post(m, fx, fy, zp, zp + 14, 0.1, 'white', 4, 0.06)
    m.box(fx, fy + 1.4, zp + 13.2, 0.04, 2.6, 1.6, 'blue')
    m.box(fx, fy + 1.4, zp + 13.2, 0.06, 2.6, 0.35, 'white')
    for y in (-50, -63.5, 40, -20):
        post(m, -55.5, y, zp, zp + 1.0, 0.33, 'navy', 5)
    # the near slope: hedges along it, trees in front of the fence, a white maintenance building in the corner
    hedge(m, [(-48.3, -90), (-48.3, -18)], 1.4, 1.1, step=40)
    hedge(m, [(-48.3, 18), (-48.3, 90)], 1.4, 1.1, step=40)
    hedge(m, [(-51.2, -84), (-51.2, -64)], 1.2, 0.9, 'bush', step=40)
    hedge(m, [(-51.2, 22), (-51.2, 86)], 1.2, 0.9, 'bush', step=40)
    for x, y in ((-50, -76), (-50.5, -38), (-50, 26), (-50.5, 62), (-50, 84), (-47.5, -94)):
        tree(m, x, y, rnd.uniform(1.1, 1.4), rnd)
    box_on(m, -66, -90, 10, 7, 3.4, 'white', z=zp)
    m.box(-66, -90, zp + 3.6, 10.6, 7.6, 0.4, 'roofc')
    m.box(-60.9, -90, zp + 1.1, 0.06, 2.6, 2.2, 'steel_d')
    rect(m, -72, -95, -60, -86, zp + 0.02, 'asphalt')
    # the road out, climbing into the hills
    drape(m, [(-118, -20), (-150, -24), (-200, -40), (-260, -70), (-340, -100)], 9, 'asphalt', step=12)
    for y in (30, -32):  # the two tall light poles on the near side, lamp banks turned to the field
        post(m, -RO - 2.6, y, -0.1, 28, 0.4, 'pole', 6, 0.22)
        m.box(-RO - 2.6, y, 28.8, 0.5, 3.6, 2.4, 'steel_d')
        m.box(-RO - 2.3, y, 28.8, 0.2, 3.2, 2.0, 'lamp')


def diamond(m, hx, hy, th, R, base, z, rnd, big=True):
    """Baseball or softball field on the upper level: mown outfield, skinned infield, grass diamond, bases, foul
    lines, outfield wall, backstop and dugouts."""
    def P(r, a):
        return (hx + r * math.cos(a), hy + r * math.sin(a))
    q = math.pi / 4
    arc = [P(R, th - q + 2 * q * i / 12) for i in range(13)]
    flat(m, [(hx, hy)] + arc, z + 0.02, 'turf_bb')
    mx, my = P(base * 0.67, th)
    dirt_r = base * 1.06
    flat(m, [(hx, hy)] + [(mx + dirt_r * math.cos(th - 1.1 + 2.2 * i / 10), my + dirt_r * math.sin(th - 1.1 + 2.2 * i / 10)) for i in range(11)], z + 0.04, 'clay')
    d1, d2, d3 = P(base, th - q), P(base * math.sqrt(2), th), P(base, th + q)
    inset = 1.6 if big else 1.1
    g = [(hx + (px - hx) * 0.9 + inset * math.cos(th), hy + (py - hy) * 0.9 + inset * math.sin(th)) for px, py in ((hx, hy), d1, d2, d3)]
    flat(m, g, z + 0.06, 'turf_bb')
    flat(m, circle(mx, my, 2.7 if big else 2.4, 8), z + 0.08, 'clay')
    flat(m, circle(hx, hy, 4.0, 8), z + 0.07, 'clay')
    for bx, by in (d1, d2, d3, (hx, hy)):
        rect(m, bx - 0.3, by - 0.3, bx + 0.3, by + 0.3, z + 0.1, 'white')
    for a in (th - q, th + q):
        e = P(R, a)
        strip(m, hx, hy, e[0], e[1], 0.1, z + 0.09, 'line')
        post(m, e[0], e[1], z, z + 9, 0.12, 'goal', 4)
    for (ax, ay), (bx, by) in zip(arc, arc[1:]):   # outfield wall (the materials are two-sided) with a yellow top
        m.quad([(ax, ay, z - 0.2), (bx, by, z - 0.2), (bx, by, z + 2.4), (ax, ay, z + 2.4)], 'fence_g')
        m.quad([(ax, ay, z + 2.4), (bx, by, z + 2.4), (bx, by, z + 2.6), (ax, ay, z + 2.6)], 'goal')
    for i in range(7):                             # backstop posts and rails
        a = th + math.pi - 0.9 + 1.8 * i / 6
        x, y = P(16 if big else 12, a)
        post(m, x, y, z, z + 7, 0.1, 'pole', 3)
    for k in range(6):
        a, b = th + math.pi - 0.9 + 1.8 * k / 6, th + math.pi - 0.9 + 1.8 * (k + 1) / 6
        (ax, ay), (bx, by) = P(16 if big else 12, a), P(16 if big else 12, b)
        m.box((ax + bx) / 2, (ay + by) / 2, z + 6.9, math.hypot(bx - ax, by - ay), 0.08, 0.1, 'pole', rot=math.atan2(by - ay, bx - ax))
        m.box((ax + bx) / 2, (ay + by) / 2, z + 0.6, math.hypot(bx - ax, by - ay), 0.2, 1.2, 'navy', rot=math.atan2(by - ay, bx - ax))
    for a in (th - q - 0.35, th + q + 0.35):       # dugouts
        x, y = P(base * 0.75, a)
        m.box(x, y, z + 1.0, 9 if big else 7, 2.6, 2.2, 'concrete', rot=a + math.pi / 2)
        m.box(x, y, z + 2.25, 9.6 if big else 7.6, 3.2, 0.3, 'blue', rot=a + math.pi / 2)
    if big:  # light poles and a small scoreboard over centre field
        for a in (th - q - 0.2, th + q + 0.2, th - 0.25, th + 0.25):
            x, y = P(R + 4 if abs(a - th) < 0.3 else 30, a)
            post(m, x, y, z, z + 22, 0.25, 'pole', 4, 0.15)
            m.box(x, y, z + 22.5, 3.2, 0.4, 1.4, 'steel_d', rot=a + math.pi / 2)
        x, y = P(R + 6, th + 0.05)
        m.box(x, y, z + 4.5, 9, 0.6, 3.6, 'board', rot=th + math.pi / 2)
        for dx in (-3, 3):
            m.box(x + dx * math.cos(th + math.pi / 2), y + dx * math.sin(th + math.pi / 2), z + 1.4, 0.35, 0.35, 2.8, 'steel_d')


def upper_level(m, rnd):
    z = UP - 0.08
    diamond(m, 88, -40, math.radians(62), 78, 27.43, z, rnd, True)
    diamond(m, 96, 108, math.radians(45), 55, 18.3, z, rnd, False)
    # walkway along the top of the slope, the diagonal path up from the track and hedges along both
    drape(m, [(71, -62), (71, 100), (64, 116)], 3.2, 'concrete', step=8)
    drape(m, [(BOWL_X - 0.5, 36), (53, 52), (60, 68), (68, 86)], 2.8, 'concrete', step=4)
    drape(m, [(-30, BOWL_Y - 1), (-10, 101), (20, 108)], 3.0, 'concrete', step=4)
    hedge(m, [(69, 34), (69, 98)], 1.5, 1.2, step=40)
    hedge(m, [(69, -36), (69, -60)], 1.5, 1.2, step=40)
    hedge(m, [(BOWL_X + 1.2, 40), (53.5, 56), (60.5, 72), (67, 86)], 1.3, 1.0, step=5)
    hedge(m, [(73.5, 34), (73.5, 98)], 1.2, 1.0, 'bush', step=40)
    # shrubs scattered over the bare earth beside the stand
    for _ in range(44):
        x, y = rnd.uniform(BOWL_X + 2, 67), rnd.choice((rnd.uniform(34, 92), rnd.uniform(-36, -32)))
        bush(m, x, y, rnd.uniform(0.7, 1.3), rnd.choice(('bush', 'bush2', 'hedge')), rnd)
    for x, y in ((50, 44), (57, 80), (63, 60), (54, 90), (65, 40)):
        tree(m, x, y, rnd.uniform(1.0, 1.5), rnd)
    # the far corner light pole beside the stand
    post(m, BOWL_X + 2, -34, 0.3, 28, 0.4, 'pole', 6, 0.22)
    m.box(BOWL_X + 2, -34, 28.8, 3.6, 0.5, 2.4, 'steel_d')
    m.box(BOWL_X + 1.7, -34, 28.8, 3.2, 0.2, 2.0, 'lamp')


def school(m, rnd):
    def building(x, y, sx, sy, h, wall, floors, roof='roofc'):
        zb = min(H(x - sx / 2, y - sy / 2), H(x + sx / 2, y + sy / 2), H(x, y))
        m.box(x, y, zb + h / 2 - 0.5, sx, sy, h + 1.0, wall)
        for f in range(floors):
            m.box(x, y, zb + (f + 0.55) * h / floors, sx + 0.12, sy + 0.12, 1.3, 'win')
        m.box(x, y, zb + h + 0.3, sx + 0.3, sy + 0.3, 0.6, wall)
        m.box(x, y, zb + h + 0.35, sx - 0.6, sy - 0.6, 0.6, roof)
        for i in range(rnd.randint(1, 2)):       # rooftop air handlers
            m.box(x + rnd.uniform(-sx / 3, sx / 3), y + rnd.uniform(-sy / 3, sy / 3), zb + h + 1.1, 2.4, 1.8, 1.2, 'alu')
        return zb

    zb = building(20, 119, 52, 16, 11, 'stucco', 3)
    text(m, 'DOLPHIN HILLS HIGH SCHOOL', (20, 110.9, zb + 9.6), (1, 0, 0), (0, 0, 1), 36, 1.0, 'navy', 0.03)
    building(-36, 121, 44, 16, 8.5, 'white', 2)
    building(-22, 152, 62, 16, 8.5, 'white', 2)
    building(-74, 140, 16, 40, 8.0, 'stucco2', 2)
    gz = building(28, 154, 34, 30, 12, 'stucco2', 1, roof='alu')
    m.box(28, 138.9, gz + 10, 34.2, 0.3, 1.2, 'blue')
    building(6, 184, 54, 14, 8, 'white', 2)
    building(-52, 182, 30, 16, 7, 'stucco', 2)
    for x0, y0, x1, y1 in ((-14, 121, -6, 121), (-10, 129, -10, 144), (-40, 160, -40, 175)):   # covered walkways
        L = math.hypot(x1 - x0, y1 - y0)
        z = H((x0 + x1) / 2, (y0 + y1) / 2)
        m.box((x0 + x1) / 2, (y0 + y1) / 2, z + 3.4, L, 3.6, 0.25, 'blue', rot=math.atan2(y1 - y0, x1 - x0))
        for i in range(int(L // 8) + 1):
            t = i / max(1, int(L // 8))
            post(m, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z, z + 3.3, 0.12, 'white', 4)
    for px, py in ((-30, 167), (-5, 170)):   # courtyards
        rect(m, px - 9, py - 4, px + 9, py + 4, H(px, py) + 0.05, 'concrete')
    for i in range(3):                       # tennis and basketball courts
        x = -125 + i * 13
        rect(m, x - 6, 168, x + 6, 194, H(x, 180) + 0.05, 'court')
        rect(m, x - 4, 172, x + 4, 190, H(x, 180) + 0.07, 'court2')
        m.box(x, 181, H(x, 180) + 0.5, 11, 0.06, 1.0, 'white')
    for i in range(2):
        x = -36 + i * 18
        rect(m, x - 8, 206, x + 8, 220, H(x, 213) + 0.05, 'asphalt2')
        for yy in (207, 219):
            m.box(x, yy, H(x, yy) + 1.6, 0.15, 0.15, 3.2, 'pole')
            m.box(x, yy, H(x, yy) + 3.2, 1.8, 0.1, 1.1, 'white')
    # palms down the fronts, trees round the courts
    for x in range(-50, 46, 10):
        palm(m, x + rnd.uniform(-1, 1), 107.6, rnd.uniform(0.95, 1.2), rnd)
    for y in range(120, 166, 11):
        palm(m, -88, y, rnd.uniform(0.9, 1.15), rnd)
    for x, y in ((48, 118), (48, 140), (-4, 170), (-70, 170), (36, 176), (-110, 120), (-108, 150)):
        palm(m, x, y, rnd.uniform(1.0, 1.25), rnd)
    for x, y in ((-140, 165), (-140, 200), (-90, 210), (-60, 225), (20, 225), (60, 200), (-110, 230)):
        tree(m, x, y, rnd.uniform(1.2, 1.7), rnd)
    # terraced hedge rows and planting beds down the school-side slope and round the north curve
    for k, yy in enumerate((97.5, 101.0, 104.5)):
        pts = [(x, yy + 0.002 * x * x * (1 + 0.3 * k)) for x in range(-62, 46, 12)]
        hedge(m, pts, 1.5 - 0.2 * k, 1.0, step=20)
    for _ in range(24):
        x, y = rnd.uniform(-60, 44), rnd.uniform(96, 106)
        bush(m, x, y, rnd.uniform(0.6, 1.0), rnd.choice(('bush', 'bush2')), rnd)
    hedge(m, [(-46, 109.5), (44, 109.5)], 1.2, 0.9, 'bush', step=40)

def hillside(m, rnd):
    """The green hillside past the south-west corner, scrub on the bluff tops and the upper level; the view past the
    scoreboard stays open to the sea."""
    for _ in range(46):
        x, y = rnd.uniform(-230, -45), rnd.uniform(-280, -100)
        if seaward(x, y) > -18:
            continue
        if rnd.random() < 0.45:
            tree(m, x, y, rnd.uniform(1.2, 2.0), rnd)
        else:
            bush(m, x, y, rnd.uniform(1.0, 2.2), rnd.choice(('bush', 'hedge')), rnd)
    for _ in range(18):   # scrub along the south bluff top (nothing between the field and the sea past the scoreboard)
        x = rnd.uniform(-45, 165)
        if abs(x) < 30:
            continue
        bush(m, x, shore_s(x) + rnd.uniform(17, 24), rnd.uniform(1.0, 1.8), rnd.choice(('bush', 'hedge')), rnd)
    for x in (-40, 48, 76, 104, 132):
        palm(m, x, shore_s(x) + 19, rnd.uniform(1.0, 1.3), rnd)
    # trees along the east bluff top, over the headland and the upper level, and on the inland hills
    for _ in range(20):
        y = rnd.uniform(-110, 260)
        x = shore(y) - rnd.uniform(17, 34)
        if seaward(x, y) < -16:
            tree(m, x, y, rnd.uniform(1.1, 1.7), rnd)
    for _ in range(32):
        x, y = rnd.uniform(75, 175), rnd.uniform(-130, 150)
        if seaward(x, y) < -16 and math.hypot(x - 88, y + 40) > 83 and math.hypot(x - 96, y - 108) > 60:   # not in the outfields
            tree(m, x, y, rnd.uniform(1.1, 1.7), rnd)
    for _ in range(6):
        x, y = rnd.uniform(-330, -150), rnd.uniform(-250, 250)
        tree(m, x, y, rnd.uniform(1.6, 2.6), rnd)

def build(m, st):
    rnd = random.Random(81)
    for k, v in dict(lawn='#7c9a4e', lawn2='#8a9f58', apron='#3e8a3c', track='#b4513b', line='#f2efe8',
                     blue='#1d4f9e', navy='#16306b', seat='#2b6f8f', seat_d='#245d78', seat_l='#7aa5ba', concrete='#cbc7bd',
                     concrete_d='#9e9b93', alu='#b4bac0', stucco='#e8e1d2', glass='#4f6a82', dirt='#b49b72', sand='#e3d3a4',
                     sea='#4a7fa6', sea_s='#5f97b9', asphalt='#4b4e53', solar='#22345c', hedge='#3e6b31', bush='#5e7d3d',
                     scrub='#4b6a36', palm_t='#7f6346', frond='#4f8a3c', steel_d='#33383f', goal='#e8c52c', orange='#e8742a',
                     turf_bb='#5e9a3e', clay='#c98f5c').items():
        m.mat(k, v)
    # near-identical colours share one material (fewer draw calls)
    for alias, k in dict(white='line', stucco2='concrete', roofc='concrete_d', alu_d='concrete_d', win='glass', bluff='dirt',
                         foam='line', asphalt2='asphalt', court='apron', court2='blue', runway='track', board='navy',
                         face='steel_d', fence_g='steel_d', trunk='palm_t', leaf='hedge', bush2='bush', pole='alu').items():
        m.slot[alias] = m.slot[k]
    m.mat('ez_decal1', '#1f50aa')
    m.mat('paint_decal2', '#f2efe8')
    m.mat('lit', '#ffcf4a', emit=1.2)
    m.mat('lamp', '#fff6d8', emit=2.0)
    terrain(m, rnd)
    sea(m, rnd)
    field_paint(m)
    track(m, st)
    home_stand(m)
    visitor_stand(m)
    snack_terrace(m, rnd)
    scoreboard(m)
    near_side(m, st, rnd)
    upper_level(m, rnd)
    school(m, rnd)
    hillside(m, rnd)
    # the photo's viewpoint: high over the near-side parking lot, looking across the field to the sea
    return dict(sky='#a5cbe8', fog=['#bfd6e8', 300, 1400], hemi=['#e8f1ff', '#6a7a4a', 1.1], sun=['#fff4e0', 2.3],
                cam=((-122, 0, 49), (78, 0, -3)), lens=22, clip=3000)
