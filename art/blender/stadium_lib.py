"""Helpers for the procedural stadiums (art/blender/stadium.py). Background mode only.

World frame is Blender's: X across the field, Y along it (the glTF export turns Y into the game's -Z), Z up. The
playing area is the field plus end zones; the physics barrier sits on a rectangle HX x HY (src/sim/drills/openField.ts
BARRIER). Everything here is flat-shaded low poly with plain colours; the only texture is the tiny crowd sprite sheet.
"""
import math
import os
import random
import struct
import zlib

import bmesh
import bpy

HX, HY = 29.38, 59.86          # inner face of the barrier: half width, half length (m)
SIDELINE, ENDLINE = 24.384, 54.864

# four rotations of the local frame (u along the stand, v away from the field) into the world XY plane
FRAMES = {'E': lambda u, v: (v, -u), 'W': lambda u, v: (-v, u), 'N': lambda u, v: (u, v), 'S': lambda u, v: (-u, -v)}
HALF = {'E': (HX, HY), 'W': (HX, HY), 'N': (HY, HX), 'S': (HY, HX)}  # (distance to the barrier, half length of the side)


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(h):
    h = h.lstrip('#')
    return tuple(lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))


def png(path, w, h, rows):
    """Write an 8-bit RGB PNG from rows of (r, g, b) bytes, standard library only."""
    raw = b''.join(b'\x00' + bytes(c for px in row for c in px) for row in rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def hex_bytes(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def crowd_sheet(path, seats, shirts, skins, empty=0.1, seed=1, sparkle=None):
    """A strip of seated spectators, 252 x 24 px, tiling sideways. Each person is 14 px wide: head, shoulders, body."""
    rnd = random.Random(seed)
    W, H = 252, 24
    px = [[hex_bytes(seats)] * W for _ in range(H)]
    for cx in range(0, W, 14):
        if rnd.random() < empty:
            continue
        sh, sk = hex_bytes(rnd.choice(shirts)), hex_bytes(rnd.choice(skins))
        hair = tuple(int(c * 0.45) for c in hex_bytes(rnd.choice(skins)))
        top = rnd.randint(0, 3)  # row of the head: people differ in height
        for y in range(top, H):
            for x in range(cx + 1, cx + 13):
                dy = y - top
                if dy < 7:                                  # head, 6 px wide
                    if 4 <= x - cx <= 9:
                        px[y][x] = hair if dy < 2 else sk
                elif dy < 9:                                # neck gap
                    pass
                else:                                       # shoulders then torso
                    inset = 1 if dy < 11 else 0
                    if cx + 1 + inset <= x <= cx + 12 - inset:
                        px[y][x] = sh
        if sparkle and rnd.random() < 0.35:                 # a raised phone, flag or lantern
            x, y = cx + rnd.choice((2, 11)), max(0, top - 1)
            for dy in range(3):
                px[y + dy][x] = hex_bytes(sparkle)
    png(path, W, H, px[::-1])  # PNG rows run top to bottom
    return path


class Mesh:
    """One object, many materials. Faces are flat shaded; every box owns its vertices."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('uv')
        self.mats, self.slot = [], {}
        self.textured = False

    def mat(self, name, color, rough=0.9, emit=0.0, tex=None, metal=0.0):
        if name in self.slot:
            return name
        m = bpy.data.materials.new(f'{self.name}_{name}')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        b = nt.nodes.new('ShaderNodeBsdfPrincipled')
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        b.inputs['Specular IOR Level'].default_value = 0.2
        c = rgb(color)
        b.inputs['Base Color'].default_value = (*c, 1)
        if tex:
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = bpy.data.images.load(tex)
            t.interpolation = 'Closest'
            t.extension = 'REPEAT'
            nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
            self.textured = True
        if emit:
            b.inputs['Emission Color'].default_value = (*c, 1)
            b.inputs['Emission Strength'].default_value = emit
        nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
        m.diffuse_color = (*c, 1)
        self.slot[name] = len(self.mats)
        self.mats.append(m)
        return name

    # ---- primitives ----
    def quad(self, pts, mat, uvs=None):
        vs = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.slot[mat]
        f.smooth = False
        if uvs:
            for lo, uv in zip(f.loops, uvs):
                lo[self.uv].uv = uv
        return f

    def tri(self, pts, mat):
        return self.quad(pts, mat)

    def solid(self, T, u0, u1, v0, v1, z0, z1, mat, skip=()):
        """Box in a local frame (T maps (u, v) to world x, y). skip: faces not drawn, from top bot lo_u hi_u lo_v hi_v."""
        P = lambda u, v, z: (*T(u, v), z)  # noqa: E731
        faces = {
            'top': [P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)],
            'bot': [P(u0, v0, z0), P(u0, v1, z0), P(u1, v1, z0), P(u1, v0, z0)],
            'lo_v': [P(u0, v0, z0), P(u1, v0, z0), P(u1, v0, z1), P(u0, v0, z1)],
            'hi_v': [P(u0, v1, z0), P(u0, v1, z1), P(u1, v1, z1), P(u1, v1, z0)],
            'hi_u': [P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1)],
            'lo_u': [P(u0, v0, z0), P(u0, v0, z1), P(u0, v1, z1), P(u0, v1, z0)],
        }
        for k, pts in faces.items():
            if k not in skip:
                self.quad(pts, mat)

    def box(self, cx, cy, cz, sx, sy, sz, mat, skip=('bot',), rot=0.0):
        """Box by centre and full size; rot turns it about Z (radians)."""
        c, s = math.cos(rot), math.sin(rot)
        T = lambda u, v: (cx + u * c - v * s, cy + u * s + v * c)  # noqa: E731
        self.solid(T, -sx / 2, sx / 2, -sy / 2, sy / 2, cz - sz / 2, cz + sz / 2, mat, skip)

    def cyl(self, cx, cy, z0, z1, r, mat, sides=8, r1=None, cap=True):
        """Prism or cone frustum (r1 = top radius, 0 for a cone)."""
        r1 = r if r1 is None else r1
        for i in range(sides):
            a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
            p = lambda a, rr, z: (cx + rr * math.cos(a), cy + rr * math.sin(a), z)  # noqa: E731
            if r1 > 0:
                self.quad([p(a0, r, z0), p(a1, r, z0), p(a1, r1, z1), p(a0, r1, z1)], mat)
                if cap:
                    self.tri([(cx, cy, z1), p(a0, r1, z1), p(a1, r1, z1)], mat)
            else:
                self.tri([p(a0, r, z0), p(a1, r, z0), (cx, cy, z1)], mat)

    def roof(self, cx, cy, sx, sy, z0, z1, mat_a, mat_b, along='y'):
        """Gabled roof: ridge at z1 along the long axis, eaves at z0."""
        hx, hy = sx / 2, sy / 2
        if along == 'y':
            self.quad([(cx - hx, cy - hy, z0), (cx, cy - hy, z1), (cx, cy + hy, z1), (cx - hx, cy + hy, z0)], mat_a)
            self.quad([(cx + hx, cy - hy, z0), (cx + hx, cy + hy, z0), (cx, cy + hy, z1), (cx, cy - hy, z1)], mat_b)
            self.tri([(cx - hx, cy - hy, z0), (cx + hx, cy - hy, z0), (cx, cy - hy, z1)], mat_a)
            self.tri([(cx + hx, cy + hy, z0), (cx - hx, cy + hy, z0), (cx, cy + hy, z1)], mat_a)
        else:
            self.quad([(cx - hx, cy - hy, z0), (cx + hx, cy - hy, z0), (cx + hx, cy, z1), (cx - hx, cy, z1)], mat_a)
            self.quad([(cx - hx, cy + hy, z0), (cx - hx, cy, z1), (cx + hx, cy, z1), (cx + hx, cy + hy, z0)], mat_b)
            self.tri([(cx - hx, cy - hy, z0), (cx - hx, cy, z1), (cx - hx, cy + hy, z0)], mat_a)
            self.tri([(cx + hx, cy + hy, z0), (cx + hx, cy, z1), (cx + hx, cy - hy, z0)], mat_a)

    # ---- rings round the barrier rectangle ----
    def section(self, side, d0, d1, z0, z1, mat, faces=('top', 'inner'), miter=True, L=None, inner_mat=None):
        """One side of a rectangular ring `d` m out from the barrier. Mitred corners meet the neighbouring sides.
        faces: top (z1), bot (z0), inner (at d0, z0..z1), outer (at d1), caps (square ends when not mitred)."""
        P, Q = HALF[side]
        T = FRAMES[side]
        v0, v1 = P + d0, P + d1
        u0 = (Q + d0) if miter else (L if L is not None else Q)
        u1 = (Q + d1) if miter else u0
        Pt = lambda u, v, z: (*T(u, v), z)  # noqa: E731
        if 'top' in faces:
            self.quad([Pt(-u0, v0, z1), Pt(u0, v0, z1), Pt(u1, v1, z1), Pt(-u1, v1, z1)], mat)
        if 'bot' in faces:
            self.quad([Pt(-u0, v0, z0), Pt(-u1, v1, z0), Pt(u1, v1, z0), Pt(u0, v0, z0)], mat)
        if 'inner' in faces:
            self.quad([Pt(-u0, v0, z0), Pt(u0, v0, z0), Pt(u0, v0, z1), Pt(-u0, v0, z1)], inner_mat or mat)
        if 'outer' in faces:
            self.quad([Pt(-u1, v1, z0), Pt(-u1, v1, z1), Pt(u1, v1, z1), Pt(u1, v1, z0)], inner_mat or mat)
        if 'caps' in faces and not miter:
            self.quad([Pt(u0, v0, z0), Pt(u1, v1, z0), Pt(u1, v1, z1), Pt(u0, v0, z1)], mat)
            self.quad([Pt(-u0, v0, z0), Pt(-u0, v0, z1), Pt(-u1, v1, z1), Pt(-u1, v1, z0)], mat)

    def ring(self, d0, d1, z0, z1, mat, faces=('top', 'inner'), sides='EWNS', inner_mat=None, L=None):
        miter = len(sides) == 4
        for s in sides:
            self.section(s, d0, d1, z0, z1, mat, faces, miter, L=None if miter else (L if L else HALF[s][1] + d0), inner_mat=inner_mat)

    def crowd(self, side, d, t, z0, z1, mat, rnd, miter=True, L=None, u_scale=10.4):
        """A vertical sprite quad of spectators facing the field, t of the way across a row that starts at d."""
        P, Q = HALF[side]
        T = FRAMES[side]
        u = (Q + d) if miter else (L if L is not None else Q)
        v = P + d + t
        o = rnd.random() * 20
        self.quad([(*T(-u, v), z0), (*T(u, v), z0), (*T(u, v), z1), (*T(-u, v), z1)], mat,
                  uvs=[(o, 0), (o + 2 * u / u_scale, 0), (o + 2 * u / u_scale, 1), (o, 1)])

    def stand(self, side_list, d_start, rows, rise, run, z_base, mat_top, mat_riser, crowd=None, rnd=None, L=None,
              crowd_h=0.95, crowd_t=0.55, back=None):
        """Raked stand: `rows` steps starting d_start out from the barrier at height z_base. Returns (d_end, z_top)."""
        miter = len(side_list) == 4
        z = z_base
        for k in range(rows):
            d0 = d_start + k * run
            z1 = z + rise
            for s in side_list:
                self.section(s, d0, d0 + run, z, z1, mat_top, ('top', 'inner'), miter, L=None if miter else (L if L else HALF[s][1] + d0), inner_mat=mat_riser)
                if crowd:
                    Lu = None if miter else (L if L else HALF[s][1] + d0)
                    self.crowd(s, d0, run * crowd_t, z1, z1 + crowd_h, crowd, rnd, miter, Lu)
            z = z1
        d_end = d_start + rows * run
        if back:
            for s in side_list:
                self.section(s, d_end, d_end, z_base, z, back, ('outer',), miter, L=None if miter else (L if L else HALF[s][1] + d_end))
        return d_end, z

    # ---- stadium-shaped (straights and semicircles) rings, for a running track round the field ----
    @staticmethod
    def oval_pts(r, c, n=24):
        """Closed counter-clockwise outline: semicircles of radius r centred (0, +-c), joined by straights."""
        top = [(r * math.cos(math.pi * k / n), c + r * math.sin(math.pi * k / n)) for k in range(n + 1)]
        bot = [(r * math.cos(math.pi + math.pi * k / n), -c + r * math.sin(math.pi + math.pi * k / n)) for k in range(n + 1)]
        return top + bot

    def oval(self, r0, r1, c, z0, z1, mat, faces=('top',), inner_mat=None, n=24):
        """Ring between two oval outlines (radii r0 < r1, semicircle centres (0, +-c)). faces: top, bot, inner, outer."""
        a, b = self.oval_pts(r0, c, n), self.oval_pts(r1, c, n)
        for i in range(len(a)):
            j = (i + 1) % len(a)
            if 'top' in faces:
                self.quad([(*a[i], z1), (*b[i], z1), (*b[j], z1), (*a[j], z1)], mat)
            if 'bot' in faces:
                self.quad([(*a[j], z0), (*b[j], z0), (*b[i], z0), (*a[i], z0)], mat)
            if 'outer' in faces:
                self.quad([(*b[i], z0), (*b[j], z0), (*b[j], z1), (*b[i], z1)], inner_mat or mat)
            if 'inner' in faces:
                self.quad([(*a[j], z0), (*a[i], z0), (*a[i], z1), (*a[j], z1)], inner_mat or mat)

    def oval_fill(self, r, c, z, mat, n=24):
        self.quad([(*p, z) for p in self.oval_pts(r, c, n)], mat)

    # ---- output ----
    def build(self, collection=None):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(self.name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        return ob
