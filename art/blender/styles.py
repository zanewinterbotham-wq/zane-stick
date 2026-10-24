"""The character styles: knobs for the shared anatomy builder (K), per-piece / per-segment post-processing,
extra pieces and the render look. Every style keeps the physics segment layout; only the surface changes."""
import common as C


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


STYLES = {  # the 'future' skin is the rigged model in art/models/futurearmor/, not a style here
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
