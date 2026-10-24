# Making models for Zane Stick: a playbook for AI agents

You are an AI agent asked to make a 3D model (an athlete skin or a prop) for Zane Stick. This guide is everything learned
building `futurearmor/` (Future Armor HD, the owner-approved reference) and `football/`. Follow it so your first
version starts at the owner's quality bar instead of iterating up to it.

The working reference implementation is [`futurearmor/build.py`](futurearmor/build.py). Read it before writing
anything; reuse its functions rather than re-deriving them.

---

## 1. Scope: what you deliver, and what you don't touch

- **Deliver:** `art/models/<id>/` with `<id>.glb` (game asset), `<id>.blend` (editable source), `build.py` (the script
  that rebuilds it), `info.json` (`label`, `pitch`), `preview.png` and `renders/` (previews, test poses, options).
  Add one row to [`README.md`](README.md): size, origin/axes, joints, materials, weights, build and check commands.
- **Do not wire it into the game.** No changes to `src/`, `public/`, `tools/models/export.ts` or `npm run
  models:export`. A separate session does the integration from your README row. (The rigid skins in
  `art/characters/` are a different, older pipeline; leave them alone.)
- **Do not commit** unless the owner asks. The repo is public: no absolute user paths, real names, real team or
  school names, or brand logos in files, commits or renders. Generic descriptions of real equipment are fine
  ("a two-bar facemask like modern helmets"), brand names and logos are not.

## 2. Tools and setup

The toolbox is the `art tools` folder next to the repo (`<repo>/../art tools`, called **AT**). Read
`AT/AGENT_GUIDE.md` once. Never write inside AT. No image-generating or text-to-3D AI; everything is made by code.

**Blender** is the portable 5.2.2 at `AT/blender/blender-5.2.2-windows-x64/` (portable mode: its add-ons and config
live in `portable/` next to the exe, not in AppData). Two ways to drive it:

| Mode | When | How |
|---|---|---|
| **Blender MCP** (live) | Iterating: build, look, fix, look | Tools `mcp__blender__*`. Run your script with `execute_blender_code` doing `exec(compile(open(p).read(), p, 'exec'), g)` and call its functions; see results with `look` or your own camera renders. |
| **Headless** | Final rebuild check, CI-like runs | `blender.exe -b --factory-startup -P art/models/<id>/build.py -- --export` |

MCP setup facts (only if the tools can't connect):
- The add-on file is `portable/scripts/addons/blender_mcp.py`; install it with
  `uvx mcp-for-blender install-addon --addons-dir "<blender>/portable/scripts/addons"`, then enable it and save
  preferences. It auto-starts its server on port 9876.
- The add-on **refuses to run its server in background mode** (`-b`), so MCP cannot be headless.
- The owner doesn't want Blender windows in their face: start it with `blender-launcher.exe` (no console window),
  then minimize the main window via user32 `ShowWindow(handle, 6)`; `Start-Process -WindowStyle Minimized` is
  ignored. `look` and renders work while minimized.
- Keep telemetry off. Don't use the paid or third-party generators.

**Save the .blend after each milestone, but the committed copy must be written with `save_blend()`** (in build.py:
`bpy.data.libraries.write` of the scenes only). A normal `save_mainfile` also stores UI and file-dialog state, which
holds this PC's user paths, and the repo is public. Delete any `.blend1` backups. To check a .blend, write an
uncompressed scene-only copy and search its bytes for the user name and `X:\Users` (compressed files hide them).

## 3. How to work with the owner

1. **Blockout first.** Before detailed work, render a quick blockout (front + three-quarter) and ask "does this
   direction look right?" If there's a real choice of direction, show two side by side.
2. **Milestone renders** (front + three-quarter) after modelling, after rigging (test poses), and final.
3. **When asked for options, render a labelled sheet** (e.g. `renders/masks.png`) and keep a build flag
   (`--mask cage`) so any option can be rebuilt.
4. **Measure before and after a fix** and report numbers ("pads were 5-8 cm off the body, now 1.2 cm").
5. Say plainly what you didn't check (e.g. "not seen in the game yet").

The owner's feedback style is a numbered list of concrete defects. Fix every item, show before/after, and record any
new lesson in this guide.

## 4. Style direction (owner decisions)

- Keep the **established Zane Stick look** (`art/concepts/sheet.png`). Inventing new styles was rejected ("those all
  suck"), so don't pitch new styles unless asked.
- Athletes: **stylised but leaning a little realistic**: super round, smooth body shapes; helmet scaled **1.4x**
  about the head joint (shipped rigid skins use 1.5x); gear on top is **sharper and realistic** (crisp bevelled
  edges, real equipment layouts).
- Rejected and must not come back:
  - the hip/belt block;
  - blobby ellipsoids "pasted on" as gear;
  - "Mickey Mouse" one-colour blob shoes;
  - thick plates that bulge off the limbs;
  - gear floating centimetres off the body;
  - legs that sit forward of the torso in profile.

## 5. The physics contract (athletes)

The game is a physics ragdoll; the model is visual only. Each bone is driven from a physics segment every frame.

- **Source of truth:** `art/tools/body.json` (regenerate with `npx tsx art/tools/dump-body.ts > art/tools/body.json`).
  21 segments: `pelvis` (root) → `lumbar` → `thorax` → `neck` → `head`; `thorax` → `clavicleL` → `upperArmL` →
  `forearmL` → `handL` (and R); `pelvis` → `thighL` → `shankL` → `footL` → `toesL` (and R). Height 1.83 m.
- **Axes:** physics x = athlete's left, y = up, z = forward. Blender is z-up: physics (x, y, z) = Blender (x, -z, y);
  the glTF exporter converts back. Use `common.P()` / `common.half()` (`art/blender/common.py`), never hand-convert.
  In Blender, the athlete faces **-y**.
- **Rest pose:** the A-pose = body.json + `common.A_POSE` (upper arms rotated out 38°, forearms 6° more).
  `seg_world(name, pose)`, `W(name)` and `J(name)` in build.py give posed frames and joint positions.
- **Bones:** one per segment, named exactly like it, same parents; head at the segment's joint, tail at the child
  joint (leaves: short stubs). Built by `make_armature()`.
- **Mesh around the joints is free; joints are not.** Shift flesh to look right (glutes and calves back), but never
  move a joint. Hands and feet collide as physics capsules, so don't exaggerate limb length or bulk.
- **Materials are named by team-colour role** so the game recolours per team: `jersey trim pants helmet mask skin
  socks cleats`; fixed: `glove visor glow` (also `ink eye pupil` if used). No jersey numbers or names (the game adds
  decals). No textures/UVs needed for athletes.
- **Budget:** 15-30k triangles (Future Armor HD: 25.3k), glb under 3 MB (770 KB), feet on the ground (z = 0).
- **Driving formula** for the integrator (document it in your README row): bone world = physics segment pose ×
  (segment A-pose rest)⁻¹ × bone rest; this is exactly what `set_pose()` does.

## 6. Modelling techniques that pass review

### 6.1 Body: a hand-laid quad cage + one subdivision level (topology the owner called "perfect")

Never ship voxel-remesh + decimate (it was rejected as "very very messy"). Build it like a modeller would
(`body_cage()`, `arm()`, `leg()`):

- **Rings lofted along each bone**: torso/neck/head 24 vertices per ring, arms 12, legs 14. Each table row is
  `(t along bone, half-width, half-depth, back offset, role)` (`TORSO`, `UPPER`, `FORE`, `HAND`, `LEG`). Tune shape by
  editing tables, not code.
- **Arms attach through a hole**: delete a 4x2 face patch on the torso side (rows 7-8, columns 22..1 / 10..13), which
  leaves a 12-vertex loop, and bridge it to the arm rings. Ring vertex angles start from the hole loop's angles and
  relax to even spacing over three rings (`even_angles()`), so nothing twists.
- **Legs attach to the torso's bottom ring**: each leg takes half the ring (13 vertices) plus **one shared crotch
  vertex** → 14-vertex loop. Every edge stays manifold.
- **Head** is an egg of rings (scaled with the helmet) closed by a pole; limb ends close with poles inside the glove
  and shoe.
- **Colour changes sit on edge loops**: set each cage face's material by its ring row (sleeve, cuff, collar, waist,
  knee, sock). After subdivision the hems stay perfectly straight. Never bisect a dense mesh for colours (jagged).
- `Mesh.obj(..., closed=True)` recalculates normals; then `subdivide(o, 1)`. Result: 100% quads (5.5k faces).
- **Check the side view.** Give the torso's lower rings a back offset (seat) and the thigh/calf rings back offsets,
  or the legs read as too far forward.

### 6.2 Gear: thin shells with crisp edges

Pattern (`grid()` + `Mesh.orient()` + `shell()`):
1. **Quad grid over parameter lines chosen so outlines land on edges.** E.g. helmet azimuth lines at ±40° make the face
   opening exact; drop cells with a `keep(u, v)` predicate (collar opening, under-arm cutaways, jaw flaps).
2. **Orient faces outward** (`M.orient(lambda p: p - centre)`) before thickening.
3. **Solidify + angle-limited Bevel** (`shell(o, thick, bevel, offset)`), which gives crisp rounded rims with a closed,
   watertight edge. Offset -1 thickens inward from a designed outer surface; +1 thickens outward from a fitted inner
   surface.
4. **Light strips are glow-material faces** on a row of the grid (helmet ridge, pad bars, guard centre line, flap
   edge), not extra geometry.
5. Cube-sphere patches (`cap_patch()`) give pole-free domes for caps and shoulders.

### 6.3 Fit, don't float

Every layer is fitted onto what is under it (`tree()`, `conform()`):
- Build a BVH of the body (and of each finished layer) with `BVHTree.FromPolygons` from the mesh data.
- `conform(trees, design_point, gap)`: closest point on the outermost surface + a small gap. Pad shell gap 12 mm;
  each further layer 4 mm; guards 2.5 mm (they use a ray cast from the bone axis instead).
- After fitting, relax folds with `bmesh.ops.smooth_vert` and re-push any vertex that sank below the gap.
- **Measure** with `find_nearest` distance stats (min / p10 / median / p90 / max) before and after.

### 6.4 Equipment details the owner checks

- **Helmet:** ellipsoid shell with a real face opening, jaw flaps and a lower nape. It has a centre ridge with a glow
  line, ear plates and a tinted visor set into the opening behind the brow bar.
- **Facemask:** round tubes (`tube()`, a bevelled curve made into a mesh). Brow bar and side rails clip to the
  helmet; bars stand off further at the chin (`mask_scale()`). Options live in `MASKS`: `twobar` (default),
  `threebar`, `eyeguard`, `cage` (lineman).
- **Shoulder pads:** a chest/back shell from a profile curve swept across the shoulders (`PAD_PROFILE`). It has a
  collar opening and under-arm cutaways, plus a layered cap and flap per shoulder (flap with a light strip). The caps
  start at the top of the shoulder, not beside the neck (otherwise they look like horns).
- **Guards** (thigh, shin, forearm): wrap-around shells about 6 mm thick from rays cast off the bone axis, slightly
  narrower at the ends (rounded rectangle), with a glow centre line.
- **Cleats:** a lofted closed upper (cleats colour) with a contrasting sole plate (trim) and 7 studs (mask). It has
  laces (trim tubes), a side stripe and a small heel counter. The sock goes into the closed top; don't cut a collar
  hole (it came out jagged). Triangle-fan caps need **per-face** colour (`Mesh.fan` takes a callable).
- **Gloves:** the arm cage continues into a flattened mitt; glove colour from the cuff ring.

### 6.5 Props (e.g. the football)

- Model detail high (seams, pebbling), then make a light game mesh: about 2k vertices with clean UVs. Bake colour and
  normal maps from the detailed one in Cycles (selected-to-active, cage extrusion about 4 mm).
- Export with JPEG textures (`export_image_format='JPEG'`); size real-world (NFL ball 0.284 × 0.171 m), origin at
  the centre.

## 7. Rigging and weights

- **Body:** `body_weights()` sends each vertex to its nearest segment, measured to the segment's surface (bone-line
  distance minus a per-segment `RADIUS`). It blends with that segment's parent/children inside `BAND` = 5 cm, at most
  4 influences.
  - **Hips get a wider band** (`WIDE`, 11 cm) so the seat follows the thighs. Without it a deep crouch shows a "box"
    from behind.
- **Rigid gear:** helmet, mask, visor, pad shell and guards get one group at weight 1 (`rigid_weights`).
- **Cleats:** blend `foot`/`toes` by distance from the toe joint over 4 cm (`foot_toes_weights`).
- **Shoulder caps:** **one constant weight** per plate (cap 20%, flap 40% upper arm). A gradient makes the plate bend
  and look crumpled when the arm goes up.
- **Test poses** (`TEST_POSES`): rest, sprint, deep crouch, arms overhead, arms crossed, tackle lean. Render each, plus
  close-ups of shoulders (overhead), hips (crouch from behind), knees (sprint) and ankles (crouch). Fix twists and
  boxy creases before export.

## 8. Export and checks

1. `export()` in build.py:
   - sets the A-pose with the rig at the origin;
   - selects only the mesh + armature;
   - glTF binary with `export_apply`, skins on, animations off, no UVs (athletes), normals on, Y-up, **no Draco**;
   - writes `info.json` and one three-quarter preview per team (`recolor(team)`).
2. `npx tsx art/tools/check-skinned.ts` must say `all N skinned models OK`. It checks joint names and parents, joint
   positions within 2 cm (A-posed arms: bone lengths), that every vertex is weighted, 15-30k triangles and under 3 MB.
3. **Headless rebuild must reproduce the triangle count exactly** (the script is the source, not the .blend):
   `blender -b --factory-startup --python-expr "...exec build.py...; build()"`.
4. Update the README row (triangles, KB, weights, options).

## 9. Reviewing your own work

- Use **camera renders** (`render(path, view, target, dist)`) for close-ups. `look` with a short `distance` puts the
  camera inside meshes and shows misleading cut-throughs.
- `look` with `shading='wireframe'` is the quickest topology check; save it as `renders/topology.png` for the owner.
- Combine shots with ImageMagick (`AT/imagemagick/magick.exe`, `montage ... -tile Nx`). Fonts whose file names
  contain `[` (e.g. Baloo2) must be copied to a plain name first.
- Glow at emission 7 renders near-white in previews; that's expected.

## 10. Gotchas (each cost a round trip)

- **QuadriFlow** in Blender 5.2 rejects meshes with any edge shorter than 1e-4 m, with a misleading "needs to be
  manifold" message. Not needed with the cage approach.
- **`BVHTree.FromObject` with a stale depsgraph** fails on objects created after it ("Cannot get a mesh from object");
  use `BVHTree.FromPolygons` from mesh data.
- **`bmesh.ops.convex_hull`:** delete only the `BMVert`s from `geom_interior`/`geom_unused` (passing mixed
  geometry raises "used multiple times").
- **Material rebuilds are slow;** `material(role)` returns the existing material unless a team is given.
- **Join keeps vertex groups by name;** create groups before `bpy.ops.object.join()` (use `temp_override`).
- **Windows Python defaults to cp1252:** open files with `encoding='utf-8'`.
- **Blender saves `.blend1` backups;** delete them before you finish.
- **PNG renders embed the .blend path as metadata** (and `look` screenshots carry a path too). `render()` turns the
  stamp metadata off; strip anything else with `magick mogrify -strip *.png` before committing.

## 11. Checklist before you say "done"

- [ ] Blockout approved by the owner (or direction stated by them)
- [ ] Body is an all-quad cage; colour changes on edge loops; side view checked
- [ ] Gear is fitted (gaps measured), thin, bevelled; no floating, no blobs, no hip block
- [ ] Bones = physics segments; A-pose rest; check-skinned passes
- [ ] Test poses + joint close-ups rendered and looked at; no twists or crumples
- [ ] Both team colourways render correctly
- [ ] Headless rebuild matches; `.blend` saved with `save_blend()` and scanned for user paths; `.blend1` deleted
- [ ] `info.json`, `preview.png`, `renders/`, README row updated
- [ ] Reported what wasn't checked; nothing committed unless asked
- [ ] New lessons added to this guide
