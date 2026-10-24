# Finished models

Models built in Blender (via MCP), ready to wire into the game. Each model has its own folder:
`<id>/<id>.glb` is the game asset, `<id>/<id>.blend` the editable source. Units are metres, glTF Y-up.
Making a new model? Read [GUIDE.md](GUIDE.md) first.

| Model | File | Size | Origin and axes | Notes |
|---|---|---|---|---|
| Future Armor HD (athlete skin) | `futurearmor/futurearmor.glb` | 1.83 m physics athlete, 1.4x helmet; 25.3k tris, 770 KB | Skinned: one mesh + armature, rest = A-pose (`common.A_POSE`). 21 joints named exactly like the physics segments, same parents; each joint sits on its physics joint (`art/tools/body.json`), bone tails point at the child joint. Feet on y = 0 | Materials by team role: `skin jersey trim pants socks cleats helmet mask` (recolour per team), fixed `glove visor glow`. No numbers baked in. No UVs/textures. Body is an all-quad subdivided cage; helmet, pad shell, guards are rigid on one joint, shoulder caps follow the arm 20%/40% (cap/flap), cleats blend foot/toes, body weights blend ≤4 joints. Facemask options `twobar` (default), `threebar`, `eyeguard`, `cage` (`renders/masks.png`). Built by `futurearmor/build.py` (`blender -b --factory-startup -P art/models/futurearmor/build.py -- --export [--mask cage]`), checked by `npx tsx art/tools/check-skinned.ts`. Driving it: bone world = physics segment pose × (segment A-pose rest)⁻¹ × bone rest — see `set_pose()` in build.py. |
| Football | `football/football.glb` | 0.284 m long, 0.171 m wide (NFL spec) | Centre of the ball; long axis X, laces on +Y | ~2.0k ball + 1.5k lace verts. Two materials: `FootballGameLeather` (colour + normal map, 2048×1024 JPEG: seams and pebbles are baked in), `FootballLaces` (plain). Laces are a child node of the ball. |
