"""Future Armor HD: a refined, rounded version of the shipped 'future' skin as ONE rigged mesh.

Body: a hand-laid quad cage (edge loops around every limb, arms and legs bridged into the torso, colour changes on
edge loops) on the physics joints (art/tools/body.json, A-pose from common.A_POSE), smoothed by one subdivision level.
Gear is modelled as shells with bevelled rims: helmet with a face opening and a choice of facemasks, layered shoulder
pads, wrap-around thigh/shin/forearm guards, cleats with sole plate, studs, stripe and laces. Everything is joined into
one object. Materials are named by team-colour role. One bone per physics segment, named after it.

Run inside Blender: live (MCP: exec this file, then build()) or headless:
  blender -b --factory-startup -P art/models/futurearmor/build.py -- [--export] [--mask twobar|threebar|eyeguard|cage]
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'art', 'blender'))
import common as C  # noqa: E402

HEAD_SCALE, HEAD_LIFT = 1.4, 0.025   # stylised big helmet (shipped skin: 1.5)
NAME = 'FutureArmor'
SEGS, ORDER = C.SEGS, C.ORDER
CHILDREN = {}
for _s in C.BODY['segments']:
    if _s['parent']:
        CHILDREN.setdefault(_s['parent'], []).append(_s['name'])
ROLES = ['skin', 'jersey', 'trim', 'pants', 'socks', 'cleats', 'glove', 'helmet', 'visor', 'glow', 'mask']
FWD = Vector((0, -1, 0))  # athlete forward in Blender


# ---------------------------------------------------------------- rig frames ----------------------------------------
def seg_world(name, pose=C.A_POSE):
    """World matrix of a segment frame in a pose (Blender XYZ degrees per segment, as common.set_pose);
    default: the export A-pose. Same chain as common.build_character."""
    s = SEGS[name]
    rot = Euler([math.radians(a) for a in pose.get(name, (0, 0, 0))]).to_matrix().to_4x4()
    if not s['parent']:
        return Matrix.Translation(C.P(s['origin'])) @ rot
    par = s['parent']
    return seg_world(par, pose) @ Matrix.Translation(C.P(s['origin']) - C.P(SEGS[par]['origin'])) @ rot


def W(name):
    """Physics rest-pose (Blender coords) -> posed world, carried by segment `name`."""
    return seg_world(name) @ Matrix.Translation(-C.P(SEGS[name]['origin']))


def J(name):
    return seg_world(name).translation.copy()


HO = C.P(SEGS['head']['origin'])
HF = W('head') @ Matrix.Translation(HO + Vector((0, 0, HEAD_LIFT))) @ Matrix.Scale(HEAD_SCALE, 4) @ Matrix.Translation(-HO)


def tail(name):
    """Bone tail: the main child joint, or a short stub for leaves."""
    main = {'pelvis': 'lumbar', 'thorax': 'neck'}.get(name) or (CHILDREN.get(name) or [None])[0]
    if main:
        return J(main)
    if name == 'head':
        return HF @ (HO + Vector((0, 0, 0.2)))
    if name.startswith('hand'):
        fa = 'forearm' + name[-1]
        return J(name) + (J(name) - J(fa)).normalized() * 0.1
    return J(name) + Vector((0, -0.06, 0))  # toes point forward (-y)


# ---------------------------------------------------------------- small math ----------------------------------------
def lerp(a, b, t):
    return a + (b - a) * t


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def table(rows, x):
    """Piecewise-linear lookup in [(x, value...)]."""
    for (x0, *a), (x1, *b) in zip(rows, rows[1:]):
        if x <= x1:
            t = 0 if x1 == x0 else (x - x0) / (x1 - x0)
            out = [lerp(p, q, max(0.0, t)) for p, q in zip(a, b)]
            return out if len(out) > 1 else out[0]
    out = rows[-1][1:]
    return list(out) if len(out) > 1 else out[0]


def sp(c, e):
    """Signed power for superellipse rings."""
    return math.copysign(abs(c) ** e, c)


def unwrap(angles):
    out = [angles[0]]
    for a in angles[1:]:
        while a - out[-1] > math.pi:
            a -= 2 * math.pi
        while a - out[-1] < -math.pi:
            a += 2 * math.pi
        out.append(a)
    return out


def even_angles(loop_angles, blend):
    """Blend a loop's (uneven) angles towards even spacing, keeping its start and direction."""
    a = unwrap(loop_angles)
    n, sgn = len(a), (1 if a[-1] > a[0] else -1)
    return [lerp(a[j], a[0] + sgn * 2 * math.pi * j / n, blend) for j in range(n)]


# ---------------------------------------------------------------- mesh building -------------------------------------
LOOK = {  # role: (roughness, metallic, coat, emission)
    'helmet': (0.22, 0.55, 0.8, 0), 'visor': (0.05, 0.0, 1.0, 0), 'mask': (0.3, 0.85, 0, 0), 'jersey': (0.45, 0.1, 0.15, 0),
    'trim': (0.4, 0, 0, 0), 'pants': (0.5, 0, 0, 0), 'socks': (0.65, 0, 0, 0), 'cleats': (0.32, 0.1, 0.5, 0),
    'skin': (0.55, 0, 0, 0), 'glove': (0.5, 0, 0, 0), 'glow': (0.3, 0, 0, 7.0),
}


def material(role, team=None):
    m = bpy.data.materials.get(role)
    if m and team is None:
        return m
    m = m or bpy.data.materials.new(role)
    team = team or 0
    rough, metal, coat, emit = LOOK[role]
    C.principled(m, C.team_colors(team)[role], rough=rough, metal=metal, coat=coat, emit=emit)
    return m


def recolor(team):
    for role in LOOK:
        material(role, team)


class Mesh:
    """Thin bmesh wrapper: verts, quads with a material role, rings, bridges, fans."""

    def __init__(self):
        self.bm = bmesh.new()

    def v(self, co):
        return self.bm.verts.new(co)

    def f(self, vs, role):
        f = self.bm.faces.new(vs)
        f.material_index = ROLES.index(role)
        return f

    def ring(self, pts):
        return [self.v(p) for p in pts]

    def bridge(self, a, b, role):
        n = len(a)
        for k in range(n):
            self.f((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]), role(k) if callable(role) else role)

    def fan(self, ring, apex, role):
        n = len(ring)
        for k in range(n):
            self.f((ring[k], ring[(k + 1) % n], apex), role(k) if callable(role) else role)

    def orient(self, outward):
        """Point every face away from the shape (outward(p) -> direction) - for open shells before solidify."""
        for f in self.bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            if f.normal.dot(outward(c)) < 0:
                f.normal_flip()

    def obj(self, name, coll, closed=False):
        bm = self.bm
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        if closed:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for r in ROLES:
            me.materials.append(material(r))
        for p in me.polygons:
            p.use_smooth = True
        o = bpy.data.objects.new(name, me)
        coll.objects.link(o)
        return o


def apply_mods(o):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    bpy.data.meshes.remove(old)
    return o


def shell(o, thick, bevel=0.0, offset=-1.0):
    """Give an open surface real thickness with a closed rim, then round the rim edges."""
    s = o.modifiers.new('Solidify', 'SOLIDIFY')
    s.thickness, s.offset, s.use_rim, s.use_even_offset, s.use_quality_normals = thick, offset, True, True, True
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL')
        b.width, b.segments, b.limit_method, b.angle_limit = bevel, 2, 'ANGLE', math.radians(40)
    return apply_mods(o)


def subdivide(o, levels=1):
    m = o.modifiers.new('Subsurf', 'SUBSURF')
    m.levels = m.render_levels = levels
    return apply_mods(o)


def grid(M, fn, us, vs, keep=lambda u, v: True, role=lambda u, v: 'helmet', wrap_u=False):
    """Quad grid over parameter lines us x vs (lines chosen so outlines fall on edges); keep/role per cell centre."""
    V = [[None] * len(vs) for _ in us]
    cells = []
    nu = len(us) if wrap_u else len(us) - 1
    for i in range(nu):
        i2 = (i + 1) % len(us)
        du = (us[i2] - us[i]) % 360 if wrap_u else us[i2] - us[i]
        uc = us[i] + du / 2
        for j in range(len(vs) - 1):
            vc = (vs[j] + vs[j + 1]) / 2
            if keep(uc, vc):
                cells.append((i, i2, j, uc, vc))
    for i, i2, j, uc, vc in cells:
        for a, b in ((i, j), (i2, j), (i2, j + 1), (i, j + 1)):
            if V[a][b] is None:
                V[a][b] = M.v(fn(us[a], vs[b]))
        M.f((V[i][j], V[i2][j], V[i2][j + 1], V[i][j + 1]), role(uc, vc))
    return V


def tube(pts, r, sides=8):
    """Round tube with closed ends through points (a bevelled curve made into a mesh) -> bmesh."""
    cu = bpy.data.curves.new('tube', 'CURVE')
    cu.dimensions, cu.bevel_depth, cu.bevel_resolution, cu.use_fill_caps = '3D', r, max(0, sides // 4 - 1), True
    sp_ = cu.splines.new('POLY')
    sp_.points.add(len(pts) - 1)
    for p, q in zip(sp_.points, pts):
        p.co = (*q, 1)
    o = bpy.data.objects.new('tube', cu)
    bpy.context.scene.collection.objects.link(o)
    me = bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(o)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    return bm


def tubes_obj(name, paths, r, role, coll, sides=8):
    me = bpy.data.meshes.new(name)
    acc = bmesh.new()
    for pts in paths:
        bm = tube(pts, r, sides)
        tmp = bpy.data.meshes.new('tmp')
        bm.to_mesh(tmp)
        bm.free()
        acc.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    for f in acc.faces:
        f.material_index = ROLES.index(role)
    acc.to_mesh(me)
    acc.free()
    for r_ in ROLES:
        me.materials.append(material(r_))
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


# ---------------------------------------------------------------- body cage -----------------------------------------
N_T, N_A, N_L = 24, 12, 14   # ring sizes: torso/neck/head, arms, legs
# torso rings from the crotch up to the neck: (z, half-width, half-depth, centre y (+ = back: seat/glutes))
TORSO = [(0.96, .170, .118, .022), (1.03, .178, .123, .020), (1.10, .163, .112, .012), (1.18, .158, .110, .008),
         (1.26, .163, .114, .006), (1.33, .172, .121, .004), (1.40, .181, .125, .004), (1.445, .186, .124, .005),
         (1.49, .186, .119, .007), (1.535, .172, .108, .010), (1.57, .125, .088, .012), (1.592, .078, .070, .016),
         (1.625, .063, .063, .020), (1.66, .062, .064, .020)]
WAIST_ROW, COLLAR_ROW, NECK_ROW = 2, 11, 12          # face rows: below WAIST_ROW pants; COLLAR_ROW trim; from NECK_ROW skin
HOLE_ROWS, HOLE_COLS = (7, 8), {'L': (22, 23, 0, 1), 'R': (10, 11, 12, 13)}  # 4x2 faces -> 12-vertex arm hole
HEAD_EGG = (Vector((0, -0.012, 1.728)), (0.080, 0.094, 0.100))
HEAD_PHI = (-45, -30, -12, 5, 22, 40, 58, 74)

# arm stations along each bone: (t, half-size across (w), half-size front-back (f), role of faces up to this ring)
UPPER = [(.12, .066, .070, 'jersey'), (.28, .062, .064, 'jersey'), (.45, .058, .060, 'jersey'), (.55, .057, .059, 'trim'),
         (.72, .054, .055, 'skin'), (.88, .050, .051, 'skin'), (1.0, .048, .048, 'skin')]
FORE = [(.14, .050, .051, 'skin'), (.32, .052, .054, 'skin'), (.55, .046, .048, 'skin'), (.76, .039, .041, 'skin'),
        (.86, .038, .040, 'skin'), (.91, .043, .045, 'glove'), (1.0, .038, .042, 'glove')]
HAND = [(.18, .026, .046, 'glove'), (.45, .028, .052, 'glove'), (.72, .026, .050, 'glove'), (.9, .019, .036, 'glove')]
# leg stations: (bone, t, half-width, half-depth, back offset, role of faces up to this ring)
LEG = [('thigh', .16, .094, .104, .028, 'pants'), ('thigh', .33, .090, .096, .022, 'pants'), ('thigh', .5, .084, .088, .015, 'pants'),
       ('thigh', .68, .077, .079, .009, 'pants'), ('thigh', .85, .068, .070, .004, 'pants'), ('thigh', 1.0, .061, .064, .0, 'pants'),
       ('shank', .08, .058, .061, .002, 'pants'), ('shank', .17, .058, .063, .007, 'trim'), ('shank', .32, .061, .069, .016, 'socks'),
       ('shank', .5, .057, .063, .014, 'socks'), ('shank', .68, .050, .052, .007, 'socks'), ('shank', .85, .043, .044, .003, 'socks'),
       ('shank', 1.0, .039, .041, .0, 'socks'), ('shank', 1.07, .034, .036, .0, 'socks')]
CROTCH_Z = 0.928


def torso_point(row, k):
    z, rx, ry, cy = TORSO[row]
    t = 2 * math.pi * k / N_T
    return Vector((rx * sp(math.cos(t), 0.9), cy - ry * math.sin(t), z))


def body_cage(coll):
    M = Mesh()
    T = [M.ring([torso_point(r, k) for k in range(N_T)]) for r in range(len(TORSO))]
    holes = {(r, k) for s in 'LR' for r in HOLE_ROWS for k in HOLE_COLS[s]}
    for i in range(len(TORSO) - 1):
        role = 'pants' if i < WAIST_ROW else 'trim' if i == COLLAR_ROW else 'skin' if i >= NECK_ROW else 'jersey'
        for k in range(N_T):
            if (i, k) not in holes:
                M.f((T[i][k], T[i][(k + 1) % N_T], T[i + 1][(k + 1) % N_T], T[i + 1][k]), role)
    # head: an egg (scaled with the helmet) on the neck, closed by a pole
    c, (rx, ry, rz) = HEAD_EGG
    prev = T[-1]
    for phi in HEAD_PHI:
        p = math.radians(phi)
        ring = M.ring([HF @ (c + Vector((rx * math.cos(p) * math.cos(t), -ry * math.cos(p) * math.sin(t), rz * math.sin(p))))
                       for t in (2 * math.pi * k / N_T for k in range(N_T))])
        M.bridge(prev, ring, 'skin')
        prev = ring
    M.fan(prev, M.v(HF @ (c + Vector((0, 0, rz)))), 'skin')
    for side in 'LR':
        arm(M, T, side)
        leg(M, T, side)
    o = M.obj(NAME + '_body', coll, closed=True)
    return subdivide(o, 1)


def arm(M, T, side):
    r0, r1 = HOLE_ROWS[0], HOLE_ROWS[1] + 1
    ks = HOLE_COLS[side]
    k0, k1 = ks[0], (ks[-1] + 1) % N_T
    loop = [T[r0][k] for k in (*ks, k1)] + [T[r0 + 1][k1]] + [T[r1][k] for k in reversed((*ks, k1))] + [T[r0 + 1][k0]]
    sh, el, wr = J('upperArm' + side), J('forearm' + side), J('hand' + side)
    tip = tail('hand' + side)
    stations = []
    for a, b, rows in ((sh, el, UPPER), (el, wr, FORE), (wr, tip, HAND)):
        d = (b - a).normalized()
        w = FWD.cross(d).normalized()
        stations += [(a + (b - a) * t, w, rw, rf, role) for t, rw, rf, role in rows]
    c0, w0 = stations[0][0], stations[0][1]
    ang = [math.atan2((v.co - c0).dot(FWD), (v.co - c0).dot(w0)) for v in loop]
    prev = loop
    for i, (c, w, rw, rf, role) in enumerate(stations):
        A = even_angles(ang, min(1.0, (i + 1) / 3))
        ring = M.ring([c + w * rw * math.cos(a) + FWD * rf * math.sin(a) for a in A])
        M.bridge(prev, ring, 'jersey' if i == 0 else role)
        prev = ring
    M.fan(prev, M.v(wr + (tip - wr) * 1.04), 'glove')


def leg(M, T, side):
    s = 1 if side == 'L' else -1
    # half of the torso's bottom ring (front centre -> side -> back centre) plus one crotch vertex shared by both legs
    ks = [(6 - i) % N_T for i in range(13)] if side == 'L' else [6 + i for i in range(13)]
    crotch = getattr(M, 'crotch', None) or M.v(Vector((0, 0.02, CROTCH_Z)))
    M.crotch = crotch
    loop = [T[0][k] for k in ks] + [crotch]
    hx = s * 0.0952
    ang = [math.atan2((v.co.y - 0.02) * -1, (v.co.x - hx)) for v in loop]
    prev = loop
    for i, (bone, t, rx, ry, back, role) in enumerate(LEG):
        a, b = J(bone + side), tail(bone + side)
        c = a + (b - a) * t + Vector((0, back, 0))
        A = even_angles(ang, min(1.0, (i + 1) / 3))
        ring = M.ring([c + Vector((rx * math.cos(q), 0, 0)) + FWD * ry * math.sin(q) for q in A])
        M.bridge(prev, ring, role)
        prev = ring
    M.fan(prev, M.v(Vector((hx, 0.0, 0.045))), 'socks')


# ---------------------------------------------------------------- helmet + facemasks --------------------------------
HG = C.geom('head', 'helmet')
HCEN = C.P(HG['pos']) + Vector((0, 0.008, 0.004))
HRAD = (HG['size'][0], HG['size'][0] * 1.07, HG['size'][0])


def hdir(a, e):
    a, e = math.radians(a), math.radians(e)
    return Vector((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))


def hpt(a, e, s=1.0, extra=0.0):
    """Point on the helmet ellipsoid (azimuth a from the front, positive to the athlete's left; elevation e), in world."""
    d = hdir(a, e)
    return HF @ (HCEN + Vector((HRAD[0] * d.x, HRAD[1] * d.y, HRAD[2] * d.z)) * s + d * extra)


AZ = [0, 3, 12, 22, 31, 40, 52, 64, 80, 100, 115, 130, 145, 158, 168, 177, 180]
AZ_ALL = [-a for a in reversed(AZ[1:-1])] + AZ   # -177 .. 180, wraps
EL = [-60, -50, -38, -25, -14, -5, 4, 10, 20, 32, 45, 58, 70, 82]


def _mid(a):
    """Distance (degrees) from the front-back centre line."""
    a = abs((a + 180) % 360 - 180)
    return min(a, 180 - a)


def helmet(coll):
    def ridge(a, e):
        m = _mid(a)
        return (0.010 if m <= 3.5 else 0.004 if m <= 12.5 else 0.0) * smooth((e - 8) / 20)

    def keep(a, e):
        a = abs((a + 180) % 360 - 180)
        if e < 10 and a < 40:
            return False                           # face opening
        bottom = -60 if a < 100 else -50 if a < 130 else -38   # jaw flaps reach down, nape is higher
        return e > bottom

    def role(a, e):
        a = (a + 180) % 360 - 180
        if _mid(a) < 3 and e > 14:
            return 'glow'                          # light line along the centre ridge
        if 80 < abs(a) < 100 and -25 < e < -5:
            return 'mask'                          # ear plates
        return 'helmet'

    M = Mesh()
    V = grid(M, lambda a, e: hpt(a, e, 1.0, ridge(a, e)), AZ_ALL, EL, keep, role, wrap_u=True)
    top = M.v(hpt(0, 90, 1.0, 0.010))
    for i in range(len(AZ_ALL)):
        i2 = (i + 1) % len(AZ_ALL)
        M.f((V[i][-1], V[i2][-1], top), role(AZ_ALL[i] + ((AZ_ALL[i2] - AZ_ALL[i]) % 360) / 2, 86))
    centre = HF @ HCEN
    M.orient(lambda p: p - centre)
    return shell(M.obj(NAME + '_helmet', coll), 0.009 * HEAD_SCALE, 0.003)


def visor(coll):
    M = Mesh()
    grid(M, lambda a, e: hpt(a, e, 0.975), [-40, -30, -20, -10, 0, 10, 20, 30, 40], [-9, -3, 3, 10],
         role=lambda a, e: 'visor')
    centre = HF @ HCEN
    M.orient(lambda p: p - centre)
    return shell(M.obj(NAME + '_visor', coll), 0.003, 0.0)


SIDE_A, BROW_E, JAW_E = 46, 10, -50
MASKS = {   # horizontal bars (elevations) and vertical bars (azimuth, from elevation, to elevation)
    'twobar':   dict(h=[-18, -44], v=[(0, -18, -44)]),
    'threebar': dict(h=[-9, -22, -44], v=[(0, -9, -44)]),
    'eyeguard': dict(h=[-18, -44], v=[(0, -18, -44), (-13, 10, -18), (13, 10, -18)]),
    'cage':     dict(h=[-9, -24, -44], v=[(0, -9, -44), (-16, -9, -44), (16, -9, -44)]),
}
MASK_R = 0.0042 * HEAD_SCALE


def mask_scale(a, e):
    """How far the cage stands off the helmet: flush at the side clips, furthest out at the chin."""
    front = math.cos(math.radians(min(abs(a), SIDE_A)) / SIDE_A * math.pi / 2) ** 0.8
    return 1.035 + front * (0.11 + 0.05 * smooth((-e - 10) / 34))


def facemask(coll, kind):
    spec = MASKS[kind]
    paths = []

    def hbar(e, a0=-SIDE_A, a1=SIDE_A, n=16):
        return [hpt(lerp(a0, a1, i / n), e, mask_scale(lerp(a0, a1, i / n), e)) for i in range(n + 1)]

    paths.append([hpt(lerp(-40, 40, i / 16), BROW_E, 1.03) for i in range(17)])            # brow bar holds the visor
    for s in (-1, 1):                                                                     # side rails, clip to jaw
        paths.append([hpt(s * lerp(40, SIDE_A, min(1, i / 3)), lerp(BROW_E, JAW_E, i / 12),
                          lerp(1.03, mask_scale(SIDE_A, lerp(BROW_E, JAW_E, i / 12)), min(1, i / 3))) for i in range(13)])
    paths += [hbar(e) for e in spec['h']]
    for a, e0, e1 in spec['v']:
        paths.append([hpt(a, lerp(e0, e1, i / 8), mask_scale(a, lerp(e0, e1, i / 8))) for i in range(9)])
    return tubes_obj(f'{NAME}_mask_{kind}', paths, MASK_R, 'mask', coll)


# ---------------------------------------------------------------- shoulder pads -------------------------------------
PAD_PROFILE = [(-0.172, 1.33), (-0.178, 1.40), (-0.166, 1.47), (-0.128, 1.54), (-0.06, 1.585), (0.02, 1.592),
               (0.095, 1.566), (0.145, 1.505), (0.165, 1.43), (0.162, 1.34)]
PAD_T = [i * 0.5 for i in range(19)]
PAD_X = [-0.235, -0.215, -0.19, -0.165, -0.14, -0.11, -0.085, -0.05, 0, 0.05, 0.085, 0.11, 0.14, 0.165, 0.19, 0.215, 0.235]


def catmull(pts, t):
    i = min(int(t), len(pts) - 2)
    u = t - i
    p0, p1, p2, p3 = (pts[max(0, i - 1)], pts[i], pts[i + 1], pts[min(len(pts) - 1, i + 2)])
    return tuple(0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u ** 3)
                 for a, b, c, d in zip(p0, p1, p2, p3))


PAD_GAP, LAYER_GAP = 0.012, 0.004   # pad shell off the jersey; each pad layer off the one under it


def tree(o):
    """BVH of a freshly built object (all pieces are built at identity transforms)."""
    return BVHTree.FromPolygons([v.co.copy() for v in o.data.vertices], [p.vertices[:] for p in o.data.polygons])


def conform(trees, p, gap):
    """Fit a design point onto the outermost surface under it: closest point on any of `trees`, pushed out by gap."""
    best = None
    for t in trees:
        q, n, _, d = t.find_nearest(p)
        if q is not None and (best is None or d < best[2]):
            best = (q, n, d)
    q, n, _ = best
    out = p - q
    return q + (out.normalized() if out.length > 1e-6 and out.dot(n) > 0 else n) * gap


def shoulder_weights(o, side, k):
    """Epaulets lift with the arm like real ones: the whole plate follows the arm by k (one weight for every vertex,
    so it tilts as a plate instead of bending)."""
    gt, ga = o.vertex_groups.new(name='thorax'), o.vertex_groups.new(name='upperArm' + side)
    ids = [v.index for v in o.data.vertices]
    gt.add(ids, 1 - k, 'REPLACE')
    ga.add(ids, k, 'REPLACE')


def pads(coll, body):
    """Shell fitted onto the jersey, then the cap fitted onto the shell and the flap onto the cap (layered, no gaps)."""
    T = W('thorax')
    trees = [tree(body)]

    def fn(x, t):
        y, z = catmull(PAD_PROFILE, t)
        k = (1 - (abs(x) / 0.29) ** 4) ** 0.25               # ends curl down over the shoulders
        return conform(trees, T @ Vector((x, y * (0.55 + 0.45 * k), 1.45 + (z - 1.45) * k)), PAD_GAP)

    def keep(x, t):
        if abs(x) < 0.085 and 3.5 < t < 6.5:
            return False                                       # collar opening
        if abs(x) > 0.165 and (t < 2.0 or t > 7.5):
            return False                                       # cut away under the arms
        if abs(x) > 0.14 and (t < 1.0 or t > 8.5):
            return False
        return True

    def role(x, t):
        return 'glow' if 1.0 < t < 1.5 and 0.05 < abs(x) < 0.14 else 'jersey'   # two light bars on the chest plate

    M = Mesh()
    grid(M, fn, PAD_X, PAD_T, keep, role)
    centre = T @ Vector((0, 0, 1.43))
    M.orient(lambda p: p - centre)
    shell_ = shell(M.obj(NAME + '_pads', coll), 0.016, 0.005, offset=1.0)
    out = [(shell_, 'thorax')]
    trees.append(tree(shell_))
    for side in 'LR':
        out += epaulets(coll, side, list(trees))
    return out


def cap_patch(M, c, frame, radii, half, ps, qs, role, fit=lambda p: p):
    """Square patch of an ellipsoid (cube-sphere mapping, no poles): frame = (e1, e2, n)."""
    e1, e2, n = frame
    ta, tb = math.tan(math.radians(half[0])), math.tan(math.radians(half[1]))

    def fn(p, q):
        d = (n + e1 * (p * ta) + e2 * (q * tb)).normalized()
        return fit(c + e1 * (d.dot(e1) * radii[0]) + e2 * (d.dot(e2) * radii[1]) + n * (d.dot(n) * radii[2]))
    grid(M, fn, ps, qs, role=role)
    M.orient(lambda p: p - c)


def epaulets(coll, side, trees):
    s = 1 if side == 'L' else -1
    sh = J('upperArm' + side)
    out = []
    # cantilever cap (under) and epaulet flap (over, further down the arm) with a light strip along its lower edge
    for name, n, off, radii, half, glow in (
            ('cap', (s * 0.55, 0, 0.84), (s * -0.02, 0, 0.0), (0.155, 0.14, 0.128), (60, 44), False),
            ('flap', (s * 0.8, 0, 0.6), (s * 0.01, 0, -0.006), (0.15, 0.12, 0.142), (54, 34), True)):
        n = Vector(n).normalized()
        e1 = FWD.copy()
        e2 = n.cross(e1).normalized()
        if e2.z > 0:
            e2 = -e2                                           # +q runs down the arm
        M = Mesh()
        qs = [-0.6, -0.3, 0, 0.25, 0.5, 0.68, 0.84, 1] if glow else [-0.55, -0.25, 0.05, 0.35, 0.65, 1]  # start at the shoulder top, not the neck
        cap_patch(M, sh + Vector(off), (e1, e2, n), radii, half, [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1], qs,
                  lambda p, q: 'glow' if glow and 0.68 < q < 0.84 and abs(p) < 0.75 else 'jersey',
                  fit=lambda p: conform(trees, p, LAYER_GAP))
        for _ in range(3):  # relax folds from the fitting, but never sink into the layer underneath
            bmesh.ops.smooth_vert(M.bm, verts=M.bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
            for v in M.bm.verts:
                if min(t.find_nearest(v.co)[3] for t in trees) < LAYER_GAP:
                    v.co = conform(trees, v.co, LAYER_GAP)
        o = shell(M.obj(f'{NAME}_{name}{side}', coll), 0.012, 0.004, offset=1.0)
        trees.append(tree(o))
        out.append((o, lambda o, side=side, k=0.4 if glow else 0.2: shoulder_weights(o, side, k)))
    return out


# ---------------------------------------------------------------- guards --------------------------------------------
GUARDS = [('thigh', 0.28, 0.72, 58, 'front'), ('shank', 0.2, 0.68, 62, 'front'), ('forearm', 0.22, 0.62, 50, 'out')]
GUARD_U = [0, .08, .2, .35, .5, .65, .8, .92, 1]
GUARD_V = [-1, -.8, -.55, -.3, -.08, .08, .3, .55, .8, 1]


def guards(coll, body):
    bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    out = []
    for side in 'LR':
        s = 1 if side == 'L' else -1
        for seg, s0, s1, phimax, facing in GUARDS:
            a, b = J(seg + side), tail(seg + side)
            d = (b - a).normalized()
            c0 = FWD.copy() if facing == 'front' else FWD.cross(d).normalized()
            if facing == 'out' and c0.x * s < 0:
                c0 = -c0
            c0 = (c0 - d * c0.dot(d)).normalized()

            def fn(u, v, a=a, b=b, d=d, c0=c0, s0=s0, s1=s1, phimax=phimax):
                t = lerp(s0, s1, u)
                phi = math.radians(phimax * v * (1 - 0.35 * (2 * u - 1) ** 6))
                dirv = Quaternion(d, phi) @ c0
                o = a + (b - a) * t
                hit = bvh.ray_cast(o, dirv, 0.3)[0]
                return (hit if hit else o + dirv * 0.07) + dirv * 0.0025

            M = Mesh()
            grid(M, fn, GUARD_U, GUARD_V, role=lambda u, v: 'glow' if abs(v) < 0.08 and 0.08 < u < 0.92 else 'helmet')
            M.orient(lambda p, a=a, d=d: (p - a) - d * (p - a).dot(d))
            out.append((shell(M.obj(f'{NAME}_{seg}{side}guard', coll), 0.006, 0.0022, offset=1.0), seg + side))
    return out


# ---------------------------------------------------------------- cleats --------------------------------------------
SHOE_U = [0, .04, .1, .18, .27, .36, .45, .54, .63, .72, .8, .87, .93, .97]
SHOE_W = [(0, .026), (.04, .031), (.1, .036), (.2, .038), (.35, .036), (.5, .039), (.65, .046), (.75, .047), (.85, .043),
          (.93, .034), (.97, .022), (1, .016)]
SHOE_TOP = [(0, .088), (.1, .096), (.25, .094), (.35, .090), (.5, .080), (.65, .066), (.8, .055), (.9, .047), (.97, .036), (1, .03)]
SHOE_N = 16
HEEL_Y, SHOE_LEN = 0.068, 0.292
STUDS = [(.07, .018), (.07, -.018), (.62, .026), (.62, -.026), (.78, .026), (.78, -.026), (.91, 0)]


def shoe_ring(sx, u, zb, top, widen=0.0, ex_lo=0.2, ex_hi=0.8):
    y = HEEL_Y - SHOE_LEN * u
    hw = table(SHOE_W, u) + widen
    zc, hh = (zb + top) / 2, (top - zb) / 2
    pts = []
    for j in range(SHOE_N):
        t = -math.pi / 2 + 2 * math.pi * j / SHOE_N           # j = 0 bottom centre, 4 outer side, 8 top, 12 inner side
        sn = math.sin(t)
        pts.append(Vector((sx + hw * sp(math.cos(t), ex_lo if sn < 0 else ex_hi), y, zc + hh * sp(sn, ex_lo if sn < 0 else ex_hi))))
    return pts


def loft(M, rings, us, role, skip=lambda uc, j: False, heel=None, toe=None):
    R = [M.ring(r) for r in rings]
    for i in range(len(R) - 1):
        uc = (us[i] + us[i + 1]) / 2
        for j in range(SHOE_N):
            if not skip(uc, j):
                M.f((R[i][j], R[i][(j + 1) % SHOE_N], R[i + 1][(j + 1) % SHOE_N], R[i + 1][j]), role(uc, j))
    if heel is not None:
        M.fan(R[0], M.v(heel), lambda j: role(0, j))
    if toe is not None:
        M.fan(R[-1], M.v(toe), lambda j: role(1, j))
    return R


def cleat(coll, side):
    s = 1 if side == 'L' else -1
    sx = s * 0.0952
    zb = 0.022

    def role(uc, j):
        jm = j if s > 0 else (SHOE_N - j) % SHOE_N            # mirror so both stripes are on the outer side
        if uc < 0.1 and jm not in range(5, 12):
            return 'trim'                                      # heel counter
        if (jm == 3 and 0.36 < uc < 0.54) or (jm == 2 and 0.5 < uc < 0.72) or (jm == 13 and 0.36 < uc < 0.54):
            return 'trim'                                      # side stripes
        return 'cleats'

    M = Mesh()   # closed upper; the sock goes in through its top like a real collar
    rings = [shoe_ring(sx, u, zb, table(SHOE_TOP, u)) for u in SHOE_U]
    loft(M, rings, SHOE_U, role, heel=Vector((sx, HEEL_Y + 0.004, 0.055)), toe=Vector((sx, HEEL_Y - SHOE_LEN * 0.995, 0.03)))
    centre = Vector((sx, HEEL_Y - SHOE_LEN / 2, 0.05))
    M.orient(lambda p: p - centre)
    upper = M.obj(f'{NAME}_upper{side}', coll, closed=True)
    # sole plate (contrast colour) and studs
    M = Mesh()
    rings = [shoe_ring(sx, u, 0.008, 0.026, 0.004, 0.12, 0.12) for u in SHOE_U]
    loft(M, rings, SHOE_U, lambda uc, j: 'trim', heel=Vector((sx, HEEL_Y + 0.006, 0.017)), toe=Vector((sx, HEEL_Y - SHOE_LEN - 0.002, 0.017)))
    sole = M.obj(f'{NAME}_sole{side}', coll, closed=True)
    bm = bmesh.new()
    for u, dx in STUDS:
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.0045, radius2=0.0075, depth=0.012)
        bmesh.ops.translate(bm, verts=res['verts'], vec=Vector((sx + s * dx, HEEL_Y - SHOE_LEN * u, 0.006)))
    for f in bm.faces:
        f.material_index = ROLES.index('mask')
    me = bpy.data.meshes.new(f'{NAME}_studs{side}')
    bm.to_mesh(me)
    bm.free()
    for r in ROLES:
        me.materials.append(material(r))
    studs = bpy.data.objects.new(me.name, me)
    coll.objects.link(studs)
    # laces across the tongue
    paths = []
    for u in (.40, .46, .52, .58, .64):
        y, z = HEEL_Y - SHOE_LEN * u, table(SHOE_TOP, u) + 0.0015
        paths.append([Vector((sx + dx, y, z - 9 * dx * dx)) for dx in (-0.019, -0.01, 0, 0.01, 0.019)])
    laces = tubes_obj(f'{NAME}_laces{side}', paths, 0.0028, 'trim', coll, 6)
    return [upper, sole, studs, laces]


def foot_toes_weights(o, side):
    """Shoe bends at the toe joint: verts behind it follow the foot, in front the toes, blended over 4 cm."""
    gf, gt = o.vertex_groups.new(name='foot' + side), o.vertex_groups.new(name='toes' + side)
    yj = J('toes' + side).y
    for v in o.data.vertices:
        w = smooth((yj + 0.02 - v.co.y) / 0.04)
        if w < 1:
            gf.add([v.index], 1 - w, 'REPLACE')
        if w > 0:
            gt.add([v.index], w, 'REPLACE')


# ---------------------------------------------------------------- weights & rig ---------------------------------------
RADIUS = {'pelvis': 0.12, 'lumbar': 0.12, 'thorax': 0.13, 'neck': 0.063, 'head': 0.14, 'clavicle': 0.05, 'upperArm': 0.058,
          'forearm': 0.045, 'hand': 0.035, 'thigh': 0.085, 'shank': 0.055, 'foot': 0.04, 'toes': 0.03}
BAND = 0.05  # metres of overlap where neighbouring segments blend
WIDE = {frozenset(('pelvis', 'thighL')): 0.11, frozenset(('pelvis', 'thighR')): 0.11}  # seat follows the thighs part way


def bone_lines():
    return {n: (J(n), tail(n), RADIUS.get(n, RADIUS.get(n[:-1]))) for n in ORDER}


def _dist(p, a, b, r):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared)) if ab.length_squared else 0.0
    return (a + ab * t - p).length - r


def body_weights(o):
    """Smooth skin weights: each vertex follows its nearest segment and blends with that segment's parent/children
    inside BAND (distance measured to each segment's surface, so thick and thin parts compare fairly)."""
    bones = bone_lines()
    groups = {n: o.vertex_groups.get(n) or o.vertex_groups.new(name=n) for n in ORDER}
    for v in o.data.vertices:
        ds = {n: _dist(v.co, *bones[n]) for n in ORDER}
        near = min(ds, key=ds.get)
        cand = {near, *CHILDREN.get(near, [])} | ({SEGS[near]['parent']} if SEGS[near]['parent'] else set())
        ws = {}
        for n in cand:
            x = 1 - (ds[n] - ds[near]) / WIDE.get(frozenset((n, near)), BAND)
            if x > 0:
                ws[n] = x * x * (3 - 2 * x)
        top = sorted(ws.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top)
        for n, w in top:
            groups[n].add([v.index], w / tot, 'REPLACE')


def rigid_weights(o, seg):
    g = o.vertex_groups.new(name=seg)
    g.add([v.index for v in o.data.vertices], 1.0, 'REPLACE')


def make_armature(coll):
    arm_ = bpy.data.armatures.new(NAME + '_rig')
    rig = bpy.data.objects.new(NAME + '_rig', arm_)
    coll.objects.link(rig)
    arm_.display_type = 'STICK'
    bpy.context.view_layer.objects.active = rig
    with bpy.context.temp_override(active_object=rig, object=rig):
        bpy.ops.object.mode_set(mode='EDIT')
        for n in ORDER:
            eb = arm_.edit_bones.new(n)
            eb.head, eb.tail, eb.roll = J(n), tail(n), 0.0
            if SEGS[n]['parent']:
                eb.parent = arm_.edit_bones[SEGS[n]['parent']]
        bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def join_and_skin(body, parts, rig):
    body_weights(body)
    for o, seg in parts:
        if callable(seg):
            seg(o)
        else:
            rigid_weights(o, seg)
    objs = [body] + [o for o, _ in parts]
    with bpy.context.temp_override(active_object=body, object=body, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    body.name = body.data.name = NAME
    body.parent = rig
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    return body


def set_pose(rig, pose, mesh=None):
    """Pose the rig like the physics would: each bone moves by its segment's world delta from the A-pose."""
    rig.location = (0, 0, 0)
    for n in ORDER:
        pb = rig.pose.bones[n]
        pb.matrix = seg_world(n, pose) @ seg_world(n).inverted() @ rig.data.bones[n].matrix_local
        bpy.context.view_layer.update()
    if mesh:  # stand on the floor
        dg = bpy.context.evaluated_depsgraph_get()
        me = mesh.evaluated_get(dg).to_mesh()
        rig.location.z = -min((mesh.matrix_world @ v.co).z for v in me.vertices)
        mesh.evaluated_get(dg).to_mesh_clear()
        bpy.context.view_layer.update()


TEST_POSES = {
    'rest': C.A_POSE,
    'sprint': {'pelvis': (14, 0, 0), 'lumbar': (6, 0, 0), 'thorax': (4, 0, 0), 'neck': (-14, 0, 0), 'head': (-8, 0, 0),
               'thighL': (-78, 0, 0), 'shankL': (72, 0, 0), 'footL': (10, 0, 0),
               'thighR': (28, 0, 0), 'shankR': (100, 0, 0), 'footR': (30, 0, 0),
               'upperArmL': (48, -12, 0), 'forearmL': (-75, 0, 0), 'upperArmR': (-62, 12, 0), 'forearmR': (-80, 0, 0)},
    'crouch': {'pelvis': (28, 0, 0), 'lumbar': (14, 0, 0), 'thorax': (8, 0, 0), 'neck': (-26, 0, 0), 'head': (-18, 0, 0),
               'thighL': (-118, 0, 6), 'shankL': (128, 0, 0), 'footL': (-12, 0, 0),
               'thighR': (-118, 0, -6), 'shankR': (128, 0, 0), 'footR': (-12, 0, 0),
               'upperArmL': (-70, -10, 0), 'forearmL': (-25, 0, 0), 'upperArmR': (-70, 10, 0), 'forearmR': (-25, 0, 0)},
    'overhead': {'upperArmL': (0, -168, 0), 'upperArmR': (0, 168, 0), 'forearmL': (0, -8, 0), 'forearmR': (0, 8, 0)},
    'crossed': {'upperArmL': (-88, 0, -42), 'forearmL': (-8, 0, -75), 'upperArmR': (-88, 0, 42), 'forearmR': (-8, 0, 75)},
    'tackle': C.ACTION,
}


# ---------------------------------------------------------------- stage, build, export --------------------------------
def render(path, view=(0.75, -1.0, 0.3), target=(0, 0, 0.95), dist=3.4, res=(560, 700), lens=50):
    sc = bpy.context.scene
    cam = bpy.data.objects.get('RenderCam') or bpy.data.objects.new('RenderCam', bpy.data.cameras.new('RenderCam'))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cam.data.lens, cam.data.clip_start = lens, 0.02
    t = Vector(target)
    cam.location = t + Vector(view).normalized() * dist
    cam.rotation_euler = (t - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        pass
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = *res, 100
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def stage():
    """Lights, world and a floor for renders."""
    sc = bpy.context.scene
    sc.view_settings.view_transform = 'Standard'
    sc.world = sc.world or bpy.data.worlds.new('World')
    sc.world.color = (0.18, 0.19, 0.21)
    for n, loc, e, size in (('Key', (1.6, -2.2, 2.6), 400, 2.0), ('Fill', (-2.2, -1.2, 1.6), 140, 3.0), ('Rim', (0.4, 2.6, 2.4), 300, 1.5)):
        L = bpy.data.objects.get(n)
        if not L:
            L = bpy.data.objects.new(n, bpy.data.lights.new(n, 'AREA'))
            sc.collection.objects.link(L)
        L.data.energy, L.data.size, L.location = e, size, loc
        L.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    if 'Floor' not in bpy.data.objects:
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=4)
        me = bpy.data.meshes.new('Floor')
        bm.to_mesh(me)
        bm.free()
        f = bpy.data.objects.new('Floor', me)
        sc.collection.objects.link(f)
        m = bpy.data.materials.get('floor') or bpy.data.materials.new('floor')
        C.principled(m, (0.2, 0.21, 0.23), rough=0.8)
        me.materials.append(m)


def clear():
    for o in list(bpy.data.objects):
        if o.name.startswith(NAME):
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.orphans_purge(do_recursive=True)
    coll = bpy.data.collections.get(NAME) or bpy.data.collections.new(NAME)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    return coll


def build_parts(mask='twobar', all_masks=False):
    """Every piece as its own object (handy to inspect); returns (body, [(object, segment or weight fn)])."""
    coll = clear()
    stage()
    body = body_cage(coll)
    parts = [(helmet(coll), 'head'), (visor(coll), 'head')]
    for kind in (MASKS if all_masks else [mask]):
        parts.append((facemask(coll, kind), 'head'))
    parts += pads(coll, body)
    parts += guards(coll, body)
    for side in 'LR':
        parts += [(o, lambda o, side=side: foot_toes_weights(o, side)) for o in cleat(coll, side)]
    return body, parts


def build(mask='twobar'):
    body, parts = build_parts(mask)
    rig = make_armature(bpy.data.collections[NAME])
    return join_and_skin(body, parts, rig), rig


INFO = {'label': 'Future Armor HD', 'pitch': 'Rounded, rigged future football: visor helmet with a glowing ridge and a '
                                               'real facemask, layered pads, wrap guards with light strips, 1.4x head.'}


def export(mesh, rig, out=HERE):
    """glb (skinned, A-pose rest), info.json and two three-quarter previews (one per team) in `out`."""
    import json
    set_pose(rig, C.A_POSE)
    rig.location = (0, 0, 0)
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        o.select_set(o in (mesh, rig))
    path = os.path.join(out, 'futurearmor.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_skins=True,
                              export_animations=False, export_texcoords=False, export_normals=True, export_yup=True,
                              export_extras=False, export_draco_mesh_compression_enable=False)
    with open(os.path.join(out, 'info.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(INFO, f, indent=1)
        f.write('\n')
    os.makedirs(os.path.join(out, 'renders'), exist_ok=True)
    for team in (0, 1):
        recolor(team)
        render(os.path.join(out, 'renders', f'preview_{C.BODY["teams"][team]["name"]}.png'))
    recolor(0)
    return path


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    mesh, rig = build(argv[argv.index('--mask') + 1] if '--mask' in argv else 'twobar')
    if '--export' in argv:
        export(mesh, rig)
