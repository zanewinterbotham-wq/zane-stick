# Regenerates the tiny picker fixture models (CC0, made here):
#   blender --background --factory-startup --python tools/picker/fixtures/make-glb.py
# The fixture .ogg and .png files were made with ffmpeg lavfi sine/noise/color sources.
import os
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
    return m


def build(path, shirt, blocky):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    skin, jersey = material('skin', (0.8, 0.6, 0.45)), material('jersey', shirt)
    if blocky:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.3), scale=(0.45, 0.25, 0.6))
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.2, depth=0.9, location=(0, 0, 1.25))
    bpy.context.object.data.materials.append(jersey)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=0.14, location=(0, 0, 1.9))
    bpy.context.object.data.materials.append(skin)
    for x in (-0.12, 0.12):
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.07, depth=0.8, location=(x, 0, 0.4))
        bpy.context.object.data.materials.append(skin)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB')


build(os.path.join(HERE, 'characters', 'stick', 'home.glb'), (0.1, 0.25, 0.7), False)
build(os.path.join(HERE, 'characters', 'stick', 'away.glb'), (0.9, 0.9, 0.9), False)
build(os.path.join(HERE, 'characters', 'blocky', 'model.glb'), (0.7, 0.15, 0.1), True)
