"""Shared building blocks for the stylised character models. Runs inside Blender in background mode only.

Coordinates: art/tools/body.json is the physics rest pose (x = athlete's left, y up, z forward, metres). Blender is
z-up, so a physics point (x, y, z) goes to Blender (x, -z, y); the glTF exporter converts back to y-up, so exported
nodes sit exactly in physics coordinates.

Each segment is one mesh object named after its physics segment. Its origin is that segment's body-frame origin
(proximal joint centre; pelvis: its COM) and its mesh is in the physics body frame at rest, so the game can copy the
physics position/quaternion straight onto the node once the hierarchy is flattened (three.js: scene.attach(node)).
The .glb is exported in an A-pose (upper arms rotated out); the node rotations only carry that pose.
Materials are named after the TeamColors field they take (jersey, trim, pants, helmet, mask, skin, socks, cleats) so a
loader can recolour per team; ink, eye, pupil, visor, glove, glow and paper are fixed or per-style colours.
"""
import json
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree
from mathutils.geometry import convex_hull_2d

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(HERE)
BODY = json.load(open(os.path.join(ART, 'tools', 'body.json'), encoding='utf-8'))
SEGS = {s['name']: s for s in BODY['segments']}
ORDER = [s['name'] for s in BODY['segments']]  # parents come before children
TEAM_ROLES = ('jersey', 'trim', 'pants', 'helmet', 'mask', 'skin', 'socks', 'cleats')


def P(v):
    """Physics point/vector -> Blender."""
    return Vector((v[0], -v[2], v[1]))


def half(h):
    """Physics box half extents -> Blender."""
    return Vector((h[0], h[2], h[1]))


def geom(seg, name):
    return next(g for g in SEGS[seg]['geoms'] if g['name'] == name)


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexrgb(h):
    return tuple(lin(((h >> s) & 255) / 255) for s in (16, 8, 0))


FIXED = {'ink': (0.006, 0.006, 0.008), 'eye': (0.92, 0.92, 0.88), 'pupil': (0.01, 0.01, 0.012),
         'visor': (0.01, 0.012, 0.016), 'glove': (0.9, 0.9, 0.88), 'paper': (0.93, 0.91, 0.85)}
GLOW = [(0.15, 0.7, 1.0), (1.0, 0.42, 0.04)]  # per team: Harbor Gulls cyan, Ridge Foxes amber


def team_colors(team):
    t = BODY['teams'][team]['colors']
    c = {r: hexrgb(t[r]) for r in TEAM_ROLES}
    c.update(FIXED)
    c['glow'] = GLOW[team]
    return c


# ---------------------------------------------------------------- pieces ---------------------------------------------
class Piece:
    def __init__(self, bm, role, smooth=True, kind='solid'):
        self.bm, self.role, self.smooth, self.kind = bm, role, smooth, kind  # kind: solid | tube | decal

    def transform(self, m):
        bmesh.ops.transform(self.bm, matrix=m, verts=self.bm.verts[:])
        return self


def _track(direction):
    return direction.to_track_quat('Z', 'Y').to_matrix().to_4x4()


def capsule(a, b, ra, rb=None, K=None, role='skin'):
    """Tapered capsule between Blender points a (radius ra) and b (radius rb)."""
    u, v = (K or {}).get('u', 12), (K or {}).get('v', 7)
    rb = ra if rb is None else rb
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v | 1, radius=1)  # odd rings: no equator ring
    L = (b - a).length
    for vt in bm.verts:
        r, s = (rb, 1) if vt.co.z > 0 else (ra, -1)
        vt.co = Vector((vt.co.x * r, vt.co.y * r, vt.co.z * r + s * L / 2))
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ _track(b - a), verts=bm.verts[:])
    return Piece(bm, role, (K or {}).get('smooth', True))


def ellipsoid(c, r, K=None, role='skin', ico=None, lo=False):
    bm = bmesh.new()
    if ico is not None:
        bmesh.ops.create_icosphere(bm, subdivisions=ico, radius=1)
    else:
        u, v = (K or {}).get('u', 12) + 4, (K or {}).get('v', 7) + 2
        if lo:  # small details (eyes, logos) need far fewer facets
            u, v = max(6, u // 2), max(4, v // 2)
        bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1)
    r = Vector(r) if hasattr(r, '__len__') else Vector((r, r, r))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(c) @ Matrix.Diagonal((*r, 1)), verts=bm.verts[:])
    return Piece(bm, role, (K or {}).get('smooth', True))


def rbox(c, h, K=None, role='jersey', taper=(1, 1), bevel=None):
    """Rounded box, Blender centre c and half extents h; taper scales the top face's (x, y) for wedge shapes."""
    K = K or {}
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2)
    b = K.get('bevel', 0.35) if bevel is None else bevel
    grid = K.get('box_cuts')
    if grid:  # evenly gridded rounded box (displacement-friendly): push a subdivided cube out onto the rounded shape
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=grid, use_grid_fill=True)
        rb = max(b, 0.05) * min(h)
        inner = [x - rb for x in h]
        for vt in bm.verts:
            p = Vector([vt.co[i] * h[i] for i in range(3)])
            q = Vector([max(-inner[i], min(inner[i], p[i])) for i in range(3)])
            d = p - q
            vt.co = Vector([(q + d.normalized() * rb)[i] / h[i] if d.length > 1e-9 else vt.co[i] for i in range(3)])
    for vt in bm.verts:
        t = (vt.co.z + 1) / 2
        sx, sy = 1 + (taper[0] - 1) * t, 1 + (taper[1] - 1) * t
        vt.co = Vector((vt.co.x * h[0] * sx, vt.co.y * h[1] * sy, vt.co.z * h[2]))
    if b > 0 and not grid:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=b * min(h), segments=K.get('bsegs', 2), profile=0.5, affect='EDGES')
    bmesh.ops.translate(bm, vec=c, verts=bm.verts[:])
    return Piece(bm, role, K.get('smooth', True) and b > 0)


def tube(pts, r, role='mask', sides=6, closed=False, flat=1.0, wide=None):
    """Swept tube along Blender points (parallel-transport frames); flat < 1 squashes it into a ribbon whose wide
    side runs along `wide`."""
    bm = bmesh.new()
    n = len(pts)
    t0 = (pts[1] - pts[0]).normalized()
    nrm = (Vector(wide) if wide else t0.orthogonal()).normalized()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[(i + 1) % n if closed else min(i + 1, n - 1)] - pts[(i - 1) % n if closed else max(i - 1, 0)]).normalized()
        nrm = (nrm - t * nrm.dot(t)).normalized()
        bi = t.cross(nrm)
        rings.append([bm.verts.new(p + r * (math.cos(2 * math.pi * k / sides) * nrm + flat * math.sin(2 * math.pi * k / sides) * bi)) for k in range(sides)])
    for i in range(n if closed else n - 1):
        a, b = rings[i], rings[(i + 1) % n]
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    if not closed:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return Piece(bm, role, True, 'tube')


def disc(c, r, thick, role='pupil', sides=16, gap=None, scale=(1, 1)):
    """Flat disc facing -Y (forward) at Blender c; gap=(a0, a1) degrees cuts a pie wedge out (rubber-hose pupils)."""
    bm = bmesh.new()
    angs = [2 * math.pi * k / sides for k in range(sides)]
    if gap:
        a0, a1 = math.radians(gap[0]), math.radians(gap[1])
        angs = [a1 + (2 * math.pi - (a1 - a0)) * k / sides for k in range(sides + 1)]  # round from a1 back to a0
    pts = [Vector((math.cos(a) * r * scale[0], 0, math.sin(a) * r * scale[1])) for a in angs]
    if gap:
        pts.append(Vector((0, 0, 0)))
    front = [bm.verts.new(c + p + Vector((0, -thick / 2, 0))) for p in pts]
    back = [bm.verts.new(c + p + Vector((0, thick / 2, 0))) for p in pts]
    bm.faces.new(front)
    bm.faces.new(back[::-1])
    m = len(pts)
    for k in range(m):
        bm.faces.new((front[(k + 1) % m], front[k], back[k], back[(k + 1) % m]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return Piece(bm, role, False, 'decal')


def text_piece(txt, c, size, depth, role='trim', back=False):
    cu = bpy.data.curves.new('num', 'FONT')
    cu.body, cu.align_x, cu.align_y, cu.size, cu.extrude, cu.resolution_u = txt, 'CENTER', 'CENTER', size, depth, 2
    cu.font = bpy.data.fonts.load('<builtin>', check_existing=True)
    ob = bpy.data.objects.new('tmpnum', cu)
    bpy.context.collection.objects.link(ob)
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    rot = Matrix.Rotation(math.pi / 2, 4, 'X')
    if back:
        rot = Matrix.Rotation(math.pi, 4, 'Z') @ rot
    bmesh.ops.transform(bm, matrix=Matrix.Translation(c) @ rot, verts=bm.verts[:])
    return Piece(bm, role, False, 'decal')


def cut_sphere(p, center, drop):
    """Delete faces of a sphere piece whose direction from centre satisfies drop(d)."""
    faces = [f for f in p.bm.faces if drop((f.calc_center_median() - center).normalized())]
    bmesh.ops.delete(p.bm, geom=faces, context='FACES')
    return p


# ---------------------------------------------------------------- anatomy --------------------------------------------
def head_frame(K):
    """Big-head transform: scale the head (helmet included) about the atlanto-occipital joint, then lift it."""
    o = P(SEGS['head']['origin'])
    return Matrix.Translation(o + Vector((0, 0, K.get('lift', 0.03)))) @ Matrix.Scale(K['head'], 4) @ Matrix.Translation(-o)


def head_pieces(K):
    hg = geom('head', 'helmet')
    hc, r = P(hg['pos']), hg['size'][0]
    ico = K.get('ico')
    shell = ellipsoid(hc, (r, r * 1.06, r), K, 'helmet', ico=K.get('helmet_ico', ico))  # shells run a little long front to back
    out = [shell]
    if K.get('visor'):
        cut_sphere(shell, hc, lambda d: d.z < -0.72)
        vis = ellipsoid(hc, (r * 1.015, r * 1.075, r * 1.015), K, 'visor')
        cut_sphere(vis, hc, lambda d: not (-d.y > 0.42 and -0.42 < d.z < 0.22))
        out += [vis]
        out += [rbox(hc + Vector((0, -r * 0.62, -r * 0.82)), Vector((r * 0.42, r * 0.28, r * 0.17)), K, 'mask')]  # chin guard
    else:
        if K.get('open_face', True):  # voxels need a closed shell; the face pokes through it instead
            cut_sphere(shell, hc, lambda d: d.z < -0.75 or (-d.y > 0.32 and -0.72 < d.z < 0.26 and abs(d.x) < 0.78))
        fc, rf = hc + Vector((0, -0.024 - K.get('face_fwd', 0), -0.02)), r * K.get('face_r', 0.8)
        out += [ellipsoid(fc, (rf, rf * 1.02, rf * 1.04), K, 'skin', ico=ico)]
        if K.get('eyes'):
            out += eyes(fc, rf, K)
        R = r * 1.07
        if K.get('mask', True):
            mr = K.get('mask_r', 0.0085)
            th = [math.radians(a) for a in range(-72, 73, 12)]
            for dz in (-0.042, -0.084):
                out.append(tube([hc + Vector((R * math.sin(a), -R * math.cos(a), dz)) for a in th], mr, 'mask'))
            phis = [math.asin(-0.084 / R) + k * (math.asin(0.03 / R) - math.asin(-0.084 / R)) / 5 for k in range(6)]
            out.append(tube([hc + Vector((0, -R * math.cos(f), R * math.sin(f))) for f in phis], mr, 'mask'))
            for s in (-1, 1):
                a = math.radians(72)
                out.append(tube([hc + Vector((s * R * math.sin(a), -R * math.cos(a), dz)) for dz in (-0.1, -0.06, -0.02)], mr, 'mask'))
    if K.get('stripe', True):
        rs = r * 1.07
        angs = [math.radians(a) for a in range(10, 206, 13)]
        out.append(tube([hc + Vector((0, -rs * math.cos(a), rs * math.sin(a))) for a in angs], r * 0.11, K.get('stripe_role', 'trim'), sides=6, flat=0.35, wide=(1, 0, 0)))
    if K.get('fin'):
        out.append(rbox(hc + Vector((0, 0.01, r * 1.0)), Vector((r * 0.06, r * 0.75, r * 0.08)), K, 'helmet'))
    for s in (-1, 1) if K.get('logo', True) else ():  # side logo
        out.append(ellipsoid(hc + Vector((s * r * 0.98, 0.01, 0.0)), (r * 0.06, r * 0.32, r * 0.28), K, 'trim', ico=ico, lo=True))
    hm = head_frame(K)
    return [p.transform(hm) for p in out]


def eyes(fc, rf, K):
    out = []
    for s in (-1, 1):
        if K.get('eyes') == 'pie':
            e = fc + Vector((s * rf * 0.3, -rf * 0.93, rf * 0.12))
            out.append(ellipsoid(e, (rf * 0.24, rf * 0.12, rf * 0.36), K, 'eye', lo=True))
            out.append(disc(e + Vector((s * rf * 0.04, -rf * 0.115, -rf * 0.02)), rf * 0.12, 0.004, 'pupil', 16, gap=(25, 70), scale=(1, 1.45)))
        else:
            d = Vector((s * 0.36, -0.9, 0.16)).normalized()
            e = fc + d * rf * 0.96
            out.append(ellipsoid(e, (rf * 0.2, rf * 0.1, rf * 0.25), K, 'eye', lo=True))
            out.append(ellipsoid(e + Vector((s * rf * 0.02, -rf * 0.08, -rf * 0.02)), (rf * 0.1, rf * 0.05, rf * 0.13), K, 'pupil', lo=True))
    return out


def torso_pieces(name, K):
    t = K.get('torso', 1.0)
    if name == 'pelvis':
        g = geom('pelvis', 'pelvis')
        c, h = P(g['pos']), half(g['size'])
        h = Vector((h.x * t, h.y * t, h.z))
        out = [rbox(c, h, K, 'pants', taper=(1.04, 1.0))]
        if K.get('belt', True):
            out.append(rbox(c + Vector((0, 0, h.z * 0.86)), Vector((h.x * 1.05, h.y * 1.05, 0.016)), K, 'trim', bevel=0.4))
        return out
    if name == 'lumbar':
        g = geom('lumbar', 'lumbar')
        h = half(g['size'])
        return [rbox(P(g['pos']), Vector((h.x * 0.95 * t, h.y * t, h.z + 0.012)), K, 'jersey', taper=(1.08, 1.06))]
    if name == 'thorax':
        y0, y1 = SEGS['thorax']['origin'][1], 1.592
        c = P((0, (y0 + y1) / 2, -0.005))
        out = [rbox(c, Vector((0.25 * t, 0.165 * t, (y1 - y0) / 2)), K, 'jersey', taper=(1.0, 1.0)).transform(Matrix())]
        # wedge: narrow the bottom of the chest towards the waist
        for vt in out[0].bm.verts:
            k = (vt.co.z - (c.z - (y1 - y0) / 2)) / (y1 - y0)
            vt.co.x *= 0.7 + 0.3 * k
            vt.co.y = c.y + (vt.co.y - c.y) * (0.82 + 0.18 * k)
        for s in (-1, 1):
            out.append(ellipsoid(P((s * 0.205 * t, 1.548, -0.005)), (0.108 * t, 0.132 * t, 0.072 * t), K, 'jersey', ico=K.get('ico')))
            if K.get('pad_stripe', True):
                out.append(tube([P((s * 0.205 * t, 1.548, -0.005)) + Vector((0, -0.134 * t * math.cos(a), 0.074 * t * math.sin(a))) for a in [math.radians(x) for x in range(25, 160, 15)]], 0.011, 'trim', sides=5))
        out.append(tube([P((0.075 * math.cos(a), 1.592, -0.035 + 0.085 * math.sin(a))) for a in [2 * math.pi * k / 14 for k in range(14)]], 0.015, 'trim', sides=6, closed=True))
        if K.get('number', True):
            out.append(text_piece(K.get('num', '27'), P((0, 1.445, 0.142 * t)), 0.17, 0.008))
            out.append(text_piece(K.get('num', '27'), P((0, 1.47, -0.168 * t)), 0.2, 0.008, back=True))
        return out
    if name == 'neck':
        g = geom('neck', 'neck')
        a, b = (P(x) for x in g['fromto'])
        return [capsule(a, b + Vector((0, 0, 0.04)), g['size'][0] * 0.95, None, K, 'skin')]
    if name.startswith('clavicle'):
        g = geom(name, name)
        a, b = (P(x) for x in g['fromto'])
        return [capsule(a, b, g['size'][0] * t, None, K, 'jersey')]
    return []


def limb_pieces(name, K):
    L = K.get('limb', 1.0)
    side = name[-1]
    base = name[:-1]
    if base in ('upperArm', 'forearm', 'thigh', 'shank'):
        g = geom(name, name)
        a, b = (P(x) for x in g['fromto'])
        r = g['size'][0] * L
        d = b - a
    if base == 'upperArm':
        out = [capsule(a, b, r, r * 0.88, K, 'skin'),
               capsule(a + d * 0.02, a + d * 0.5, r * 1.2, r * 1.1, K, 'jersey')]
        if K.get('sleeve_stripe', True):
            out.append(tube([a + d * 0.4 + Vector((r * 1.18 * math.cos(q), r * 1.18 * math.sin(q), 0)) for q in [2 * math.pi * k / 12 for k in range(12)]], 0.009 * max(L, 0.7), 'trim', closed=True))
        return out
    if base == 'forearm':
        return [capsule(a, b, r, r * 0.8, K, 'skin'),
                capsule(a + d * 0.82, a + d * 0.98, r * 0.92, r * 0.88, K, 'trim')]
    if base == 'thigh':
        out = [capsule(a, b, r * 1.02, r * 0.74, K, 'pants')]
        if K.get('leg_stripe', True):
            s = 1 if side == 'L' else -1
            out.append(tube([a + d * k + Vector((s * r * (1.0 - 0.27 * k) * 0.99, 0, 0)) for k in (0.08, 0.35, 0.62, 0.9)], 0.013 * max(L, 0.7), 'trim', sides=5, flat=0.5, wide=(0, 1, 0)))
        return out
    if base == 'shank':
        return [capsule(a, b, r * 1.0, r * 0.72, K, 'socks'),
                capsule(a - d * 0.02, a + d * 0.2, r * 1.18, r * 1.06, K, 'pants')]
    if base == 'hand':
        return hand_pieces(name, K)
    if base in ('foot', 'toes'):
        return foot_pieces(name, K)
    return []


def hand_pieces(name, K):
    g = next(x for x in SEGS[name]['geoms'] if x['type'] == 'box')
    c, h = P(g['pos']), half(g['size'])
    w = P(SEGS[name]['origin'])
    s = 1 if name.endswith('L') else -1
    role = K.get('glove', 'trim')
    if K.get('hands') == 'mitt':
        out = [ellipsoid(c + Vector((0, 0, 0.02)), (h.x * 1.6, h.y * 1.15, h.z * 0.72), K, role),
               capsule(w + Vector((0, -h.y * 0.5, -0.04)), w + Vector((s * -0.005, -h.y * 1.25, -0.075)), 0.017, 0.016, K, role)]
        if K.get('cuff'):
            out.append(capsule(w + Vector((0, 0, 0.012)), w + Vector((0, 0, -0.022)), 0.052, 0.048, K, role))
    else:
        out = [rbox(c, Vector((h.x * 1.05, h.y, h.z * 0.92)), K, role, bevel=0.45),
               capsule(w + Vector((0, -h.y * 0.6, -0.035)), w + Vector((0, -h.y * 1.35, -0.07)), 0.014, 0.012, K, role)]
    hs = K.get('hand', 1.0)
    m = Matrix.Translation(w) @ Matrix.Scale(hs, 4) @ Matrix.Translation(-w)
    return [p.transform(m) for p in out]


def foot_pieces(name, K):
    g = next(x for x in SEGS[name]['geoms'] if x['type'] == 'box')
    c, h = P(g['pos']), half(g['size'])
    out = []
    if K.get('feet') == 'round':
        if name.startswith('foot'):
            out.append(ellipsoid(c + Vector((0, 0.005, 0.01)), (h.x * 1.25, h.y * 1.18, h.z * 1.45), K, 'cleats'))
        else:
            out.append(ellipsoid(c + Vector((0, -0.01, 0.005)), (h.x * 1.3, h.y * 1.9, h.z * 1.5), K, 'cleats'))
    elif name.startswith('foot'):
        out.append(rbox(c + Vector((0, 0, 0.004)), Vector((h.x * 1.1, h.y * 1.05, h.z * 1.05)), K, 'cleats', bevel=0.4))
        out.append(rbox(Vector((c.x, c.y, 0.009)), Vector((h.x * 1.12, h.y * 1.07, 0.009)), K, 'mask', bevel=0.3))
    else:
        out.append(rbox(c + Vector((0, 0.0, 0.003)), Vector((h.x * 1.1, h.y * 1.1, h.z * 1.05)), K, 'cleats', taper=(0.9, 1.0), bevel=0.7))
        out.append(rbox(Vector((c.x, c.y, 0.009)), Vector((h.x * 1.12, h.y * 1.12, 0.009)), K, 'mask', bevel=0.5))
    fs = K.get('foot', 1.0)
    o = P(SEGS['foot' + name[-1]]['origin'])
    o = Vector((o.x, o.y, 0.0))
    m = Matrix.Translation(o) @ Matrix.Scale(fs, 4) @ Matrix.Translation(-o)
    return [p.transform(m) for p in out]


def segment_pieces(name, K):
    if name == 'head':
        return head_pieces(K)
    out = torso_pieces(name, K) or limb_pieces(name, K)
    return out


# ---------------------------------------------------------------- style post-processing ------------------------------
def jitter(p, amp=0.006, freq=9.0):
    for v in p.bm.verts:
        v.co += noise.noise_vector(v.co * freq) * amp
    p.smooth = False


def lumps(p, amp=0.004, freq=14.0):
    bmesh.ops.recalc_face_normals(p.bm, faces=p.bm.faces[:])
    p.bm.normal_update()
    for v in p.bm.verts:
        n = v.normal.copy()
        v.co += n * (noise.noise(v.co * freq) * amp + noise.noise(v.co * freq * 3.1) * amp * 0.35)


def voxelize(pieces, h):
    """Rebuild a segment as voxels on a world grid of size h: last piece containing a cell wins (overlays on top)."""
    trees = []
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for p in pieces:
        bmesh.ops.recalc_face_normals(p.bm, faces=p.bm.faces[:])
        trees.append((BVHTree.FromBMesh(p.bm), p.role))
        for v in p.bm.verts:
            lo = Vector(map(min, lo, v.co))
            hi = Vector(map(max, hi, v.co))
    cells = {}
    rng = [range(math.floor(lo[i] / h), math.ceil(hi[i] / h)) for i in range(3)]
    for i in rng[0]:
        for j in rng[1]:
            for k in rng[2]:
                q = Vector(((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h))
                for tree, role in reversed(trees):
                    loc, nrm, _, dist = tree.find_nearest(q)
                    if loc is not None and (q - loc).dot(nrm) < 0:
                        cells[(i, j, k)] = role
                        break
    nbr = [((1, 0, 0), (1, 2)), ((-1, 0, 0), (2, 1)), ((0, 1, 0), (2, 0)), ((0, -1, 0), (0, 2)), ((0, 0, 1), (0, 1)), ((0, 0, -1), (1, 0))]
    by_role = {}
    for (i, j, k), role in cells.items():
        bm, vmap = by_role.setdefault(role, (bmesh.new(), {}))

        def vert(x, y, z):
            key = (x, y, z)
            if key not in vmap:
                vmap[key] = bm.verts.new((x * h, y * h, z * h))
            return vmap[key]
        for (dx, dy, dz), (u, w) in nbr:
            if (i + dx, j + dy, k + dz) in cells:
                continue
            ax = 0 if dx else 1 if dy else 2
            base = [i, j, k]
            if (dx, dy, dz)[ax] > 0:
                base[ax] += 1
            e1, e2 = [0, 0, 0], [0, 0, 0]
            e1[u], e2[w] = 1, 1
            c = [base, [base[m] + e1[m] for m in range(3)], [base[m] + e1[m] + e2[m] for m in range(3)], [base[m] + e2[m] for m in range(3)]]
            bm.faces.new([vert(*x) for x in c])
    out = []
    for role, (bm, _) in by_role.items():
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bmesh.ops.dissolve_limit(bm, angle_limit=0.001, verts=bm.verts[:], edges=bm.edges[:], delimit={'NORMAL'})
        out.append(Piece(bm, role, False))
    return out


def paperize(pieces, thick=0.007, border=0.011):
    """Paper puppet: each piece becomes a flat card of its front silhouette at its own depth; a paper-white border
    card sits behind the whole segment."""
    out, allpts = [], []
    ys = []
    for p in pieces:
        co = [v.co.copy() for v in p.bm.verts]
        if not co:
            continue
        ymid = sum(c.y for c in co) / len(co)
        ymin = min(c.y for c in co)
        if p.kind in ('tube', 'decal'):
            for v in p.bm.verts:  # ribbons and decals: squash flat onto their front
                v.co.y = ymin + (v.co.y - ymin) * 0.25
            p.smooth = False
            out.append(p)
            continue
        pts2 = [(c.x, c.z) for c in co]
        hull = [pts2[i] for i in convex_hull_2d(pts2)]
        allpts += hull
        y = ymid - 0.3 * (ymid - ymin)  # cards sit toward the front so layering follows depth
        t = min(0.03, max(thick, 0.22 * (max(c.y for c in co) - ymin)))  # foam-board: thicker for bulkier parts
        ys.append(y + t / 2)
        out.append(Piece(prism(hull, y, t), p.role, False))
    if allpts:
        hull = [allpts[i] for i in convex_hull_2d(allpts)]
        out.insert(0, Piece(prism(offset_poly(hull, border), max(ys) + 0.004, 0.008), 'paper', False))
    return out


def prism(poly, y, thick):
    bm = bmesh.new()
    f = [bm.verts.new((x, y - thick / 2, z)) for x, z in poly]
    b = [bm.verts.new((x, y + thick / 2, z)) for x, z in poly]
    bm.faces.new(f)
    bm.faces.new(b[::-1])
    n = len(poly)
    for k in range(n):
        bm.faces.new((f[(k + 1) % n], f[k], b[k], b[(k + 1) % n]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def offset_poly(poly, d):
    n = len(poly)
    pts = [Vector(p) for p in poly]
    area = sum(pts[k].x * pts[(k + 1) % n].y - pts[(k + 1) % n].x * pts[k].y for k in range(n))
    sgn = 1 if area > 0 else -1  # outward normal of an edge is (dy, -dx) for counter-clockwise polygons
    out = []
    for k in range(n):
        a, b, c = pts[k - 1], pts[k], pts[(k + 1) % n]
        n1 = Vector(((b - a).y, -(b - a).x)).normalized() * sgn
        n2 = Vector(((c - b).y, -(c - b).x)).normalized() * sgn
        m = (n1 + n2).normalized()
        out.append(tuple(b + m * d / max(0.3, m.dot(n1))))
    return out


# ---------------------------------------------------------------- objects, materials ---------------------------------
def material(role):
    m = bpy.data.materials.get(role) or bpy.data.materials.new(role)
    return m


def make_segment(name, pieces):
    bm = bmesh.new()
    slots = []
    o = P(SEGS[name]['origin'])
    for p in pieces:
        if not p.bm.faces:
            continue
        if p.role not in slots:
            slots.append(p.role)
        tmp = bpy.data.meshes.new('tmp')
        p.bm.to_mesh(tmp)
        n0 = len(bm.faces)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        bm.faces.ensure_lookup_table()
        for f in bm.faces[n0:]:
            f.material_index = slots.index(p.role)
            f.smooth = p.smooth
        p.bm.free()
    bmesh.ops.translate(bm, vec=-o, verts=bm.verts[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for r in slots:
        me.materials.append(material(r))
    ob = bpy.data.objects.new(name, me)
    ob.location = o
    bpy.context.collection.objects.link(ob)
    return ob


def build_character(style):
    K = style['K']
    objs = {}
    for name in ORDER:
        pieces = segment_pieces(name, K) + (style['extra'](name, K) if style.get('extra') else [])
        for p in pieces:
            if style.get('piece'):
                style['piece'](p)
        if style.get('segment'):
            pieces = style['segment'](pieces)
        objs[name] = make_segment(name, pieces)
    for name in ORDER:
        par = SEGS[name]['parent']
        if par:
            objs[name].parent = objs[par]
            objs[name].matrix_parent_inverse = Matrix.Translation(-P(SEGS[par]['origin']))
    if K.get('outline'):
        ink = material('ink')
        for ob in objs.values():
            ob.data.materials.append(ink)
            sol = ob.modifiers.new('Outline', 'SOLIDIFY')
            sol.thickness, sol.offset, sol.use_flip_normals, sol.use_rim = K['outline'], 1.0, True, False
            sol.material_offset = len(ob.data.materials) - 1  # Blender clamps to the last slot: every shell face is ink
    return objs


A_POSE = {'upperArmL': (0, -38, 0), 'upperArmR': (0, 38, 0), 'forearmL': (0, -6, 0), 'forearmR': (0, 6, 0)}
# Tackle lean: hips and trunk pitched forward, head up, lead knee driving, arms reaching to wrap (Blender XYZ degrees;
# +X pitches a segment's top forward, -X swings a hanging limb forward).
ACTION = {'pelvis': (34, 0, -8), 'lumbar': (10, 0, -4), 'thorax': (8, 0, -4), 'neck': (-24, 0, 0), 'head': (-22, 0, 4),
          'thighL': (-102, 0, 4), 'shankL': (92, 0, 0), 'footL': (-6, 0, 0), 'toesL': (0, 0, 0),
          'thighR': (-6, 0, -4), 'shankR': (42, 0, 0), 'footR': (34, 0, 0), 'toesR': (-30, 0, 0),
          'clavicleL': (0, 0, 0), 'upperArmL': (-118, -22, -10), 'forearmL': (-42, 0, 0), 'handL': (0, 0, 0),
          'clavicleR': (0, 0, 0), 'upperArmR': (-92, 30, 10), 'forearmR': (-58, 0, 0), 'handR': (0, 0, 0)}


def set_pose(objs, pose, ground=True):
    for name, ob in objs.items():
        ob.rotation_euler = [math.radians(a) for a in pose.get(name, (0, 0, 0))]
        if name == 'pelvis':
            ob.location = P(SEGS['pelvis']['origin'])
    bpy.context.view_layer.update()
    if not ground:  # export: the pelvis stays exactly at its physics origin
        return
    low = min((ob.matrix_world @ v.co).z for ob in objs.values() for v in ob.data.vertices)
    objs['pelvis'].location.z -= low
    bpy.context.view_layer.update()


def tri_count(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for ob in objs.values():
        me = ob.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
        ob.evaluated_get(dg).to_mesh_clear()
    return n


# ---------------------------------------------------------------- looks (node trees) ---------------------------------
def _tree(m):
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    return nt, nt.nodes.new('ShaderNodeOutputMaterial')


def principled(m, rgb, rough=0.7, metal=0.0, emit=0.0, coat=0.0, sss=0.0):
    nt, out = _tree(m)
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*rgb, 1)
        b.inputs['Emission Strength'].default_value = emit
    if coat:
        b.inputs['Coat Weight'].default_value = coat
    if sss:
        b.inputs['Subsurface Weight'].default_value = sss
        b.inputs['Subsurface Radius'].default_value = (0.02, 0.01, 0.008)
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    m.diffuse_color = (*rgb, 1)
    return nt, b


def export_look(m, role, rgb):
    """What the .glb carries: plain metal/rough PBR (glTF cannot hold toon ramps)."""
    principled(m, rgb, rough={'helmet': 0.35, 'visor': 0.1, 'mask': 0.4}.get(role, 0.75),
               metal=0.5 if role == 'mask' else 0.0, emit=3.0 if role == 'glow' else 0.0)
    m.use_backface_culling = role == 'ink'


def toon(m, rgb, shadow=0.55, split=0.38, rim=False):
    nt, out = _tree(m)
    dif = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    emi = nt.nodes.new('ShaderNodeEmission')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].color = (*[c * shadow for c in rgb], 1)
    ramp.color_ramp.elements[1].position = split
    ramp.color_ramp.elements[1].color = (*rgb, 1)
    if rim:
        e = ramp.color_ramp.elements.new(0.92)
        e.color = (*[min(1, c * 1.25 + 0.06) for c in rgb], 1)
    nt.links.new(dif.outputs['BSDF'], s2r.inputs['Shader'])
    nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], emi.inputs['Color'])
    nt.links.new(emi.outputs['Emission'], out.inputs['Surface'])


def flat_emit(m, rgb, k=1.0):
    nt, out = _tree(m)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs['Color'].default_value = (*[c * k for c in rgb], 1)
    nt.links.new(e.outputs['Emission'], out.inputs['Surface'])


def ink_look(m, rgb):
    flat_emit(m, rgb)
    m.use_backface_culling = True
    m.use_backface_culling_shadow = True


def bumped(m, b, scale, strength, detail=6.0):
    nt = m.node_tree
    tex = nt.nodes.new('ShaderNodeTexNoise')
    tex.inputs['Scale'].default_value = scale
    tex.inputs['Detail'].default_value = detail
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = 0.002
    nt.links.new(tex.outputs['Fac'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])


def apply_looks(look, team):
    cols = team_colors(team)
    for m in bpy.data.materials:
        if m.name in cols:
            look(m, m.name, cols[m.name])


# ---------------------------------------------------------------- stage, render, export ------------------------------
def export_glb(objs, path, normals=True):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs.values():
        ob.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, use_selection=True,
                              export_texcoords=False, export_normals=normals, export_animations=False, export_extras=False, export_yup=True)


class Stage:
    """Camera, lights and a curved backdrop on one rig that turns to each view, so lighting stays the same."""

    def __init__(self, bg=0.2):
        sc = bpy.context.scene
        sc.render.engine = 'BLENDER_EEVEE'
        sc.eevee.taa_render_samples = 48
        sc.render.resolution_x, sc.render.resolution_y = 520, 650
        sc.render.film_transparent = False
        sc.render.image_settings.file_format = 'PNG'
        sc.render.image_settings.color_mode = 'RGB'
        sc.render.image_settings.compression = 90
        sc.render.dither_intensity = 0  # smooth backdrop gradients compress far better
        sc.view_settings.view_transform = 'Standard'
        w = bpy.data.worlds.new('World')
        sc.world = w
        w.use_nodes = True
        bgn = w.node_tree.nodes.get('Background') or w.node_tree.nodes.new('ShaderNodeBackground')
        bgn.inputs['Color'].default_value = (0.42, 0.43, 0.45, 1)
        bgn.inputs['Strength'].default_value = 0.5
        self.rig = bpy.data.objects.new('rig', None)
        sc.collection.objects.link(self.rig)
        self._backdrop(bg)
        cam = bpy.data.cameras.new('cam')
        self.cam = bpy.data.objects.new('cam', cam)
        sc.collection.objects.link(self.cam)
        sc.camera = self.cam
        self._light('key', 'AREA', (-3.2, -4.0, 4.6), 520, 2.5, shadow=True)
        self._light('fill', 'AREA', (4.0, -3.0, 2.0), 170, 4.0)
        self._light('rim', 'AREA', (1.5, 4.5, 3.8), 450, 2.0)

    def _backdrop(self, bg):
        bm = bmesh.new()
        prof = [(-8, 0)] + [(3 + 2.5 * math.sin(a), 2.5 - 2.5 * math.cos(a)) for a in [math.pi / 2 * k / 8 for k in range(9)]] + [(5.5, 12)]
        rows = [[bm.verts.new((x, y, z)) for (y, z) in prof] for x in (-14, 14)]
        for k in range(len(prof) - 1):
            bm.faces.new((rows[0][k], rows[1][k], rows[1][k + 1], rows[0][k + 1]))
        me = bpy.data.meshes.new('backdrop')
        bm.to_mesh(me)
        bm.free()
        me.shade_smooth()
        m = bpy.data.materials.new('backdrop_mat')
        principled(m, (bg, bg, bg * 1.03), rough=0.95)
        me.materials.append(m)
        ob = bpy.data.objects.new('backdrop', me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = self.rig

    def _light(self, name, kind, loc, energy, size, shadow=False):
        ld = bpy.data.lights.new(name, kind)
        ld.energy, ld.use_shadow = energy, shadow
        ld.size = size
        ob = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = self.rig
        ob.location = loc
        ob.rotation_euler = (Vector((0, 0, 0.9)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()

    def shoot(self, objs, path, azimuth, ortho=True, elev=0.0, lens=40):
        self.rig.rotation_euler = (0, 0, math.radians(azimuth))
        bpy.context.view_layer.update()
        R = self.rig.matrix_world.to_3x3()
        fwd = R @ Vector((0, 1, -math.tan(math.radians(elev)))).normalized()  # camera looks along this
        up = Vector((0, 0, 1))
        right = fwd.cross(up).normalized()
        up = right.cross(fwd)
        pts = [ob.matrix_world @ v.co for ob in objs.values() for v in ob.data.vertices]
        xs = [p.dot(right) for p in pts]
        ys = [p.dot(up) for p in pts]
        aspect = 520 / 650
        cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        cd = self.cam.data
        if ortho:
            cd.type = 'ORTHO'
            cd.ortho_scale = 1.12 * max(max(ys) - min(ys), (max(xs) - min(xs)) / aspect)
            dist = 8
        else:
            cd.type = 'PERSP'
            cd.lens = lens
            fov = 2 * math.atan(18 * aspect / lens)
            rad = 0.5 * max(max(ys) - min(ys), (max(xs) - min(xs)) / aspect * 0.95)
            dist = 1.15 * rad / math.tan(fov / 2) + 0.4
        cd.clip_end = 60
        center = right * cx + up * cy + fwd * (sum(p.dot(fwd) for p in pts) / len(pts))
        self.cam.location = center - fwd * dist
        self.cam.rotation_euler = fwd.to_track_quat('-Z', 'Y').to_euler()
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
