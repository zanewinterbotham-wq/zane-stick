"""The character styles: knobs for the shared anatomy builder (K), per-piece / per-segment post-processing,
extra pieces and the render look. Every style keeps the physics segment layout; only the surface changes."""
import math

from mathutils import Vector

import common as C


def armor(name, K):
    """Sleek future kit: hard plates on the limbs with light strips."""
    base = name[:-1]
    if base not in ('thigh', 'shank', 'forearm'):
        return []
    g = C.geom(name, name)
    a, b = (C.P(x) for x in g['fromto'])
    r, d = g['size'][0] * K.get('limb', 1.0), b - a
    s = 1 if name.endswith('L') else -1
    if base == 'forearm':  # guard on the outside of the forearm
        c = a + d * 0.45 + Vector((s * r * 0.92, 0, 0))
        return [C.rbox(c, Vector((0.012, r * 0.8, d.length * 0.3)), K, 'helmet', bevel=0.5),
                C.rbox(c + Vector((s * 0.011, 0, 0)), Vector((0.003, 0.005, d.length * 0.22)), K, 'glow', bevel=0)]
    k = 0.42 if base == 'thigh' else 0.4
    c = a + d * k + Vector((0, -r * (0.93 if base == 'thigh' else 0.95), 0))
    hh = d.length * (0.28 if base == 'thigh' else 0.32)
    return [C.rbox(c, Vector((r * 0.78, 0.016, hh)), K, 'helmet', taper=(0.85, 1), bevel=0.5),
            C.rbox(c + Vector((0, -0.014, 0)), Vector((0.005, 0.004, hh * 0.8)), K, 'glow', bevel=0)]


def chest_glow(name, K):
    if name != 'thorax':
        return []
    return [C.rbox(C.P((0, 1.405, 0.138)), Vector((0.16, 0.006, 0.006)), K, 'glow', bevel=0),
            C.rbox(C.P((0, 1.37, 0.128)), Vector((0.12, 0.006, 0.005)), K, 'glow', bevel=0)]


# ---- looks ----------------------------------------------------------------------------------------------------------
def look_vinyl(m, role, rgb):
    if role == 'ink':
        return C.ink_look(m, rgb)
    C.principled(m, rgb, rough=0.12 if role in ('pupil', 'visor') else 0.3, coat=0.6, metal=0.3 if role == 'mask' else 0)


def look_matte(m, role, rgb):
    C.principled(m, rgb, rough=0.85 if role != 'helmet' else 0.5, metal=0.4 if role == 'mask' else 0)


def look_toon(m, role, rgb):
    if role == 'ink':
        return C.ink_look(m, rgb)
    C.toon(m, rgb, shadow=0.58, split=0.42, rim=role in ('helmet', 'jersey'))


def look_hose(m, role, rgb):
    if role == 'ink':
        return C.ink_look(m, rgb)
    C.toon(m, rgb, shadow=0.72, split=0.3)


def look_clay(m, role, rgb):
    nt, b = C.principled(m, rgb, rough=0.92, sss=0.12)
    C.bumped(m, b, scale=28, strength=0.55)


def look_paper(m, role, rgb):
    nt, b = C.principled(m, rgb, rough=1.0, emit=0.55)
    C.bumped(m, b, scale=220, strength=0.12, detail=4)


def look_future(m, role, rgb):
    if role == 'glow':
        return C.principled(m, rgb, emit=7.0)
    C.principled(m, rgb, rough={'helmet': 0.2, 'visor': 0.04, 'mask': 0.25, 'jersey': 0.4, 'trim': 0.3}.get(role, 0.55),
                 metal={'helmet': 0.65, 'mask': 0.8, 'jersey': 0.15}.get(role, 0.05), coat=0.8 if role in ('helmet', 'visor') else 0)


STYLES = {
    'vinyl': dict(
        title='Vinyl Toy', pitch='Chunky designer-toy figure: glossy rounded plastic, mitten hands, 1.9x head.',
        K=dict(head=1.9, lift=0.035, limb=1.5, torso=1.06, hand=1.25, hands='mitt', feet='round', foot=1.3,
               u=14, v=9, bevel=0.75, bsegs=4, eyes=True, mask_r=0.012, leg_stripe=False), look=look_vinyl),
    'lowpoly': dict(
        title='Low-Poly Facet', pitch='Faceted crystal-cut athlete: six-sided limbs, jittered flat facets, 1.55x head.',
        K=dict(head=1.55, limb=1.05, u=6, v=5, ico=1, helmet_ico=2, smooth=False, bevel=0.3, bsegs=1, number=False,
               sleeve_stripe=False), flat=True,
        piece=lambda p: C.jitter(p, 0.005), look=look_matte),
    'toon': dict(
        title='Ink Toon', pitch='Saturday-morning cel shading: two-tone ramps, rim highlight, inked outlines, 1.75x head.',
        K=dict(head=1.75, limb=1.12, u=8, v=5, eyes=True, outline=0.011, foot=1.1), look=look_toon),
    'voxel': dict(
        title='Voxel Block', pitch='3.4 cm voxels on one world grid with merged faces: a sandbox-game athlete, 1.6x head.',
        K=dict(head=1.6, u=10, v=7, eyes=True, mask=False, open_face=False, face_r=0.66, face_fwd=0.035, logo=False, number=False, pad_stripe=False, sleeve_stripe=False,
               leg_stripe=False, stripe=False, limb=1.1, torso=1.05),
        segment=lambda ps: C.voxelize(ps, 0.034), look=look_matte, flat=True),
    'clay': dict(
        title='Claymation', pitch='Stop-motion plasticine: lumpy hand-pressed surfaces, soft matte, 1.65x head.',
        K=dict(head=1.65, limb=1.22, torso=1.04, u=12, v=9, box_cuts=3, bevel=0.55, eyes=True, hands='mitt',
               feet='round', foot=1.15, mask_r=0.011),
        piece=lambda p: C.lumps(p, 0.011, 6.0), look=look_clay),
    'future': dict(
        title='Future Armor', pitch='Sleek armored future football: visor helmet with fin, hard plates, light strips.',
        K=dict(head=1.5, limb=1.0, u=10, v=7, bevel=0.3, bsegs=1, visor=True, fin=True, stripe_role='glow', number=False, leg_stripe=False,
               sleeve_stripe=False, pad_stripe=False),
        extra=lambda n, K: armor(n, K) + chest_glow(n, K), look=look_future),
    'paper': dict(
        title='Paper Cutout', pitch='Layered cardstock puppet: flat silhouettes, paper-white borders, 1.7x head.',
        K=dict(head=1.7, limb=1.15, u=14, v=9, eyes=True, foot=1.1),
        segment=C.paperize, look=look_paper, flat=True, action_az=-30),
    'rubberhose': dict(
        title='Rubber Hose', pitch='1930s cartoon: noodle limbs, white mitts, pie-cut eyes, huge shoes, 1.95x head.',
        K=dict(head=1.95, lift=0.04, limb=0.45, torso=0.95, hand=1.9, hands='mitt', glove='glove', cuff=True,
               feet='round', foot=1.65, eyes='pie', outline=0.009, leg_stripe=False, sleeve_stripe=False, u=8, v=5),
        look=look_hose),
}
