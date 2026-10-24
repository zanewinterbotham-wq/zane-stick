// Three.js view of a World. Reads physics state only; never writes it.
import * as THREE from 'three';
import type { World } from '../../sim/world';
import { clamp } from '../../sim/math';
import { AthleteMesh, TEAMS } from './athleteMesh';
import { AnatomyOverlay } from './anatomy';
import { GORE_LEVELS, InjuryEffects } from './effects';
import { buildBarrier, buildField } from './field';
import { FieldLinesView } from './fieldLines';
import { LandingMarker } from './landing';
import { PassAim } from './passAim';
import { NameTags } from './nametags';
import { loadStadium, OPEN_FIELD, stadiumById, type Stadium, type StadiumScene } from './stadium';
import { ExpressionTracker } from '../expressions';
import type { Expression } from './brows';
import type { Voice } from './mouth';
import { CLASSIC, loadSkin, skinById, type Skin, type SkinTemplate } from './skin';
import { CrowdFx, pushUniforms } from './crowd';
import { buildFloodlights, disposeFloodlights } from './lights';
import { ContactShadows, TurfMarks } from './turf';
import { addStain, identFor, stainKey, stainOf } from './uniform';

/** Graphics knobs of a quality level (presets.ts). `scale`: resolution × the device pixel ratio, which is first capped
 *  at `pixelCap`; `shadowMap`: shadow map size (px); `effects`: share of the injury particles drawn; `faces`: farthest
 *  athlete from the camera (m) whose mouth and brows animate; `maxFps`: frame cap (0 = the display's rate); `decals`: jersey
 *  numbers, helmet marks and the night stadium's floodlights (Medium and up); `ao`: softer sun shadows and contact shadows
 *  under feet and bodies (High and Ultra). Absent = off. */
export interface RenderQuality { scale: number; shadows: boolean; detail: 'low' | 'high'; antialias: boolean; shadowMap: number; pixelCap: number; effects: number; faces: number; maxFps: number; decals?: boolean; ao?: boolean }

/** The Open Field's sky and light (what the renderer starts with). */
const OPEN_SCENE: StadiumScene = { sky: '#9cc3e4', fog: ['#9cc3e4', 80, 220], hemi: ['#dfeeff', '#3c5a2c', 1.1], sun: ['#ffffff', 2.2] };
/** One WebGLRenderer per canvas, shared by every GameRenderer on it: a canvas hands back its first context (and that
 *  context's antialias) to every later request, so a second WebGLRenderer would only duplicate the GPU buffers. */
const gls = new WeakMap<HTMLCanvasElement, THREE.WebGLRenderer>();

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1500); // far enough for a stadium's sea horizon
  athletes: AthleteMesh[] = [];
  overlay: AnatomyOverlay | null = null;
  xray = false;
  /** Tint muscles by effort; only in the anatomy view, where it reads as data rather than as damage. */
  effortShading = true;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private barrier: THREE.Group;
  stadium: Stadium = OPEN_FIELD;
  private stadiumRoot: THREE.Group | null = null;
  private stadiumReq = 0;
  private props: THREE.Object3D[] = [];
  private world: World | null = null;
  skin: Skin = CLASSIC;
  private template: SkinTemplate | null = null;
  private skinReq = 0;
  /** Athlete whose head is not drawn (the helmet camera looks out from inside it), or -1. */
  hideHeadOf = -1;
  /** Injury effects (blood, bones, stars); the Gore setting picks their style (render/effects.ts GORE_LEVELS). */
  readonly effects = new InjuryEffects();
  /** Kicked-up turf and scuff marks (render/turf.ts), the stadium crowd's mood (render/crowd.ts), and (High/Ultra) contact shadows. */
  readonly turf = new TurfMarks();
  readonly crowd = new CrowdFx();
  /** The blue line of scrimmage and the yellow first-down line (main.ts sets them each rep). */
  readonly fieldLines = new FieldLinesView();
  private contact: ContactShadows | null = null;
  private floodlights: THREE.Group | null = null;
  /** Each athlete's stain slot (team:rank), for the grass stains that last the session. */
  private slots: string[] = [];
  private stainT = 0;
  set goreLevel(level: number) {
    const id = GORE_LEVELS[clamp(Math.round(level), 0, GORE_LEVELS.length - 1)].style;
    if (this.effects.style.id !== id) this.effects.setStyle(id);
  }
  /** Target ring where a loose ball in the air will land (render/landing.ts). */
  readonly landing = new LandingMarker();
  /** The QB throw scheme's aim aids (main.ts sets them each frame). */
  readonly passAim = new PassAim();
  /** Multiplayer: who is a person and who a bot, over their heads (main.ts sets them; none in single player). */
  readonly tags = new NameTags();
  /** Render time of the last frame (ms) and the last frame's draw calls. */
  lastMs = 0;
  private lastFrame = performance.now();
  private faces = new ExpressionTracker();

  constructor(canvas: HTMLCanvasElement, public quality: RenderQuality) {
    let gl = gls.get(canvas);
    if (!gl) gls.set(canvas, gl = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance' }));
    this.renderer = gl;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelCap) * quality.scale);
    this.effects.density = this.turf.density = quality.effects;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x9cc3e4);
    this.scene.fog = new THREE.Fog(0x9cc3e4, 80, 220);
    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x3c5a2c, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(-20, 40, 15);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.sun.shadow.normalBias = 0.02; // no self-shadow acne on the skins' faceted and cel-shaded surfaces
    if (quality.ao) this.sun.shadow.radius = 3; // softer shadow edges (blur radius, in shadow-map texels)
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 100;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(buildField(quality.detail), this.fieldLines.root, this.effects.root, this.turf.root, this.landing.root, this.landing.path, this.passAim.root, this.tags.root);
    if (quality.ao) { this.contact = new ContactShadows(); this.scene.add(this.contact.root); }
    this.barrier = buildBarrier();
    this.scene.add(this.barrier);
    this.resize();
  }

  /** Load a stadium (fetched once) and put it round the field with its sky and light; an unknown, locked or
   *  unloadable stadium is the Open Field. */
  async setStadium(id: string) {
    const want = stadiumById(id), req = ++this.stadiumReq;
    if (want === this.stadium && (this.stadiumRoot || !want.file)) return;
    let root: THREE.Group | null = null;
    try { root = (await loadStadium(want)) ?? null; } catch (e) { console.warn(`stadium ${want.id} failed to load; using the Open Field`, e); }
    if (req !== this.stadiumReq) return; // a later choice won
    this.stadium = root ? want : OPEN_FIELD;
    if (this.stadiumRoot) this.scene.remove(this.stadiumRoot);
    this.stadiumRoot = root;
    if (root) this.scene.add(root);
    this.barrier.visible = !root;
    if (this.floodlights) { this.scene.remove(this.floodlights); disposeFloodlights(this.floodlights); this.floodlights = null; }
    if (root && this.quality.decals) { this.floodlights = buildFloodlights(this.stadium.id); if (this.floodlights) this.scene.add(this.floodlights); }
    const sc = this.stadium.scene ?? OPEN_SCENE;
    (this.scene.background as THREE.Color).set(sc.sky);
    this.scene.fog = new THREE.Fog(sc.fog[0], sc.fog[1], sc.fog[2]);
    this.hemi.color.set(sc.hemi[0]); this.hemi.groundColor.set(sc.hemi[1]); this.hemi.intensity = sc.hemi[2];
    this.sun.color.set(sc.sun[0]); this.sun.intensity = sc.sun[1];
  }

  /** Load a skin (fetched once) and dress the athletes in it now; a locked, unknown or unloadable skin is Classic. */
  async setSkin(id: string) {
    const want = skinById(id), req = ++this.skinReq;
    if (want === this.skin && (this.template || !want.file)) return;
    let tpl: SkinTemplate | null = null;
    try { tpl = await loadSkin(want); } catch (e) { console.warn(`skin ${want.id} failed to load; using Classic`, e); }
    if (req !== this.skinReq) return; // a later choice won
    this.skin = tpl ? want : CLASSIC;
    this.template = tpl;
    if (this.world) this.dress(this.world);
  }

  private dress(w: World) {
    for (const a of this.athletes) { this.scene.remove(a.root); a.dispose(); }
    const rank = [0, 0]; // an athlete's place on his team gives his number, name and stain slot
    this.slots = w.athletes.map((a) => stainKey(a.setup.team, rank[a.setup.team]++));
    this.athletes = w.athletes.map((a, i) => {
      const r = +this.slots[i].split(':')[1];
      return new AthleteMesh(a.plan, TEAMS[a.setup.team], this.quality.detail, this.template, { ident: this.quality.decals ? identFor(a.setup.team, r) : undefined, stain: stainOf(this.slots[i]) });
    });
    for (const a of this.athletes) { a.setXray(this.xray); this.scene.add(a.root); }
  }

  /** A voice sound has started on an athlete: their mouth follows it (see render/mouth.ts). */
  voice(v: Voice) { this.athletes[v.athlete]?.mouth?.driver.say(v); }

  /** Call after every World step: the athletes' moods (eyebrows) follow the hits, injuries and approach (expressions.ts). */
  stepFaces(w: World, dt = w.dt) {
    if (w !== this.world) return;
    this.faces.step(w, dt).forEach((e, i) => { const b = this.athletes[i]?.brows; if (b) b.driver.target = e; });
  }

  /** Worker mode: the athletes' moods, worked out where the steps ran (one per athlete, as stepFaces gives). */
  setFaces(e: Expression[]) { e.forEach((x, i) => { const b = this.athletes[i]?.brows; if (b) b.driver.target = x; }); }

  setWorld(w: World) {
    this.world = w;
    this.faces = new ExpressionTracker();
    this.turf.clear();
    this.stainT = w.time;
    for (const p of this.props) { this.scene.remove(p); disposeTree(p); }
    if (this.overlay) { this.scene.remove(this.overlay.root); disposeTree(this.overlay.root); }
    this.dress(w);
    this.props = (w.setup.props ?? []).map((p) => {
      if (p.hidden) return new THREE.Object3D(); // a collision wall: the stadium draws it (kept so prop indices line up)
      const geo = p.shape === 'box' ? new THREE.BoxGeometry(2 * p.size[0], 2 * p.size[1], 2 * p.size[2])
        : p.shape === 'capsule' ? new THREE.CapsuleGeometry(p.size[0], 2 * p.size[1], 4, 10)
        : new THREE.SphereGeometry(1, 16, 12).scale(p.size[0], p.size[1], p.size[2]);
      const color = p.name === 'goalpost' ? 0xf2cf1d : p.mass > 0 && p.mass < 1 ? 0x7a3b16 : 0xc8462b;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
      mesh.castShadow = true;
      mesh.position.set(...p.pos);
      if (p.quat) mesh.quaternion.set(...p.quat); // static props are never re-posed per frame (the sumo ring's tangent rails)
      this.scene.add(mesh);
      return mesh;
    });
    this.overlay = new AnatomyOverlay(w);
    this.overlay.root.visible = this.xray;
    this.scene.add(this.overlay.root);
    this.setXray(this.xray);
  }

  setXray(on: boolean) {
    this.xray = on;
    for (const a of this.athletes) a.setXray(on);
    if (this.overlay) this.overlay.root.visible = on;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- render interpolation
  /** The pose before the latest fixed step (athletes' segments, dynamic props) and the step count it belongs to. */
  private prev: { w: World; steps: number; pos: Float64Array[]; quat: Float64Array[]; props: (Vec7 | null)[] } | null = null;
  /** This frame's poses, between the last two steps (lerp(), read by render() and the camera). */
  readonly poses: { segPos: Float64Array; segQuat: Float64Array }[] = [];
  private posed: World | null = null;

  /** Call before each fixed step: keeps the pose the step starts from (render only; the sim never sees it). */
  snapshot(w: World) {
    if (this.prev?.w !== w) this.prev = { w, steps: -1, pos: w.scene.athletes.map((a) => new Float64Array(a.state.segPos.length)), quat: w.scene.athletes.map((a) => new Float64Array(a.state.segQuat.length)), props: [] };
    const p = this.prev;
    w.scene.athletes.forEach((a, i) => { p.pos[i].set(a.state.segPos); p.quat[i].set(a.state.segQuat); });
    p.props = (w.setup.props ?? []).map((d, i) => (d.mass > 0 ? (({ pos, quat }) => [...pos, ...quat] as Vec7)(w.scene.propPose(i)) : null));
    p.steps = w.steps;
  }

  /** This frame's poses at `alpha` (0..1) of the way from the pose before the last step to the latest one, so the
   *  motion is smooth whatever the frame rate is against the physics rate; the latest pose when there is no previous
   *  one (a multiplayer replica, the first frame). Call once a frame before the camera and render(). */
  lerp(w: World, alpha: number) {
    const p = this.prev, on = !!p && p.w === w && p.steps === w.steps - 1 && alpha < 1;
    this.posed = w;
    w.scene.athletes.forEach((a, i) => {
      const s = a.state;
      if (!on) { this.poses[i] = { segPos: s.segPos, segQuat: s.segQuat }; return; }
      let o = this.poses[i];
      if (!o || o.segPos === s.segPos || o.segPos.length !== s.segPos.length) o = this.poses[i] = { segPos: new Float64Array(s.segPos.length), segQuat: new Float64Array(s.segQuat.length) };
      lerpPose(p.pos[i], p.quat[i], s.segPos, s.segQuat, alpha, o.segPos, o.segQuat);
    });
    this.poses.length = w.scene.athletes.length;
    this.propAlpha = on ? alpha : 1;
  }
  private propAlpha = 1;

  /** `focus`: the athlete the shadow camera stays on (the one the view follows). */
  render(w: World, focus = 0) {
    if (w !== this.world) return; // a new rep whose skin is still loading
    const t0 = performance.now(), dt = (t0 - this.lastFrame) / 1000;
    this.lastFrame = t0;
    if (this.posed !== w) this.lerp(w, 1);
    this.posed = null;
    const cam = this.camera.position, far = this.quality.faces;
    w.athletes.forEach((a, i) => {
      const s = this.poses[i], mesh = this.athletes[i], k = 3 * (a.segIndex.get('head') ?? 0);
      mesh.pose(s.segPos, s.segQuat);
      // far faces keep their last expression: a mouth or brow a few pixels tall is not worth its update
      if (far === Infinity || Math.hypot(s.segPos[k] - cam.x, s.segPos[k + 1] - cam.y, s.segPos[k + 2] - cam.z) < far) { mesh.mouth?.update(dt); mesh.brows?.update(dt); }
      mesh.setHeadVisible(i !== this.hideHeadOf);
      mesh.shade(this.xray && this.effortShading ? segmentEffort(a) : null);
    });
    const pa = this.propAlpha, pp = this.prev?.props;
    (w.setup.props ?? []).forEach((p, i) => {
      if (p.mass <= 0) return;
      const { pos, quat } = w.scene.propPose(i), q0 = pa < 1 ? pp?.[i] : null;
      if (q0) {
        lerpPose(q0.slice(0, 3), q0.slice(3), pos, quat, pa, tmpPos, tmpQuat);
        this.props[i].position.set(tmpPos[0], tmpPos[1], tmpPos[2]);
        this.props[i].quaternion.set(tmpQuat[0], tmpQuat[1], tmpQuat[2], tmpQuat[3]);
        return;
      }
      this.props[i].position.set(...pos);
      this.props[i].quaternion.set(...quat);
    });
    if (this.overlay?.root.visible) this.overlay.update(w);
    this.effects.follow(w);
    this.turf.follow(w, this.poses, dt);
    this.contact?.update(w, this.poses);
    this.crowd.step(dt); pushUniforms(this.crowd);
    const sd = w.time - this.stainT; // simulated time since the last frame (none while paused)
    this.stainT = w.time;
    if (sd > 0 && sd < 0.5) w.athletes.forEach((a, i) => { // down on the turf, an athlete picks up grass stains (more when he slides)
      if (a.downBy === null) return;
      const v = w.scene.athletes[i].state.comVel;
      this.athletes[i].setStain(addStain(this.slots[i], sd, Math.min(Math.hypot(v[0], v[2]), 8) * sd));
    });
    this.landing.update(w);
    this.tags.update(w.athletes.map((a, i) => { const k = 3 * (a.segIndex.get('head') ?? 0), p = this.poses[i].segPos; return [p[k], p[k + 1], p[k + 2]]; }));
    // keep the shadow camera on the action
    const c = (w.scene.athletes[focus] ?? w.scene.athletes[0]).state.com;
    this.sun.target.position.set(c[0], 0, c[2]);
    this.sun.position.set(c[0] - 20, 40, c[2] + 15);
    this.renderer.render(this.scene, this.camera);
    this.lastMs = performance.now() - t0;
  }
}

/** Free the GPU buffers of every geometry and material under `o` (an object leaving the scene for good; disposing twice
 *  is harmless). Never on a skin's meshes: their geometry is the cached template's. */
export function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.geometry) return;
    if (!m.geometry.userData.shared) m.geometry.dispose(); // the shared decal planes and their materials (uniform.ts) live on
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (!mat?.userData.shared) mat?.dispose();
  });
}

type Vec7 = [number, number, number, number, number, number, number];
const tmpPos = new Float64Array(3), tmpQuat = new Float64Array(4);

/** Poses `alpha` of the way from (p0, q0) to (p1, q1): positions lerped, quaternions (x y z w) nlerped along the
 *  shorter arc, per segment. */
export function lerpPose(p0: ArrayLike<number>, q0: ArrayLike<number>, p1: ArrayLike<number>, q1: ArrayLike<number>, alpha: number, po: Float64Array, qo: Float64Array) {
  for (let i = 0; i < po.length; i++) po[i] = p0[i] + (p1[i] - p0[i]) * alpha;
  for (let i = 0; i < qo.length; i += 4) {
    const sg = q0[i] * q1[i] + q0[i + 1] * q1[i + 1] + q0[i + 2] * q1[i + 2] + q0[i + 3] * q1[i + 3] < 0 ? -1 : 1;
    let n = 0;
    for (let j = i; j < i + 4; j++) n += (qo[j] = q0[j] + (sg * q1[j] - q0[j]) * alpha) ** 2;
    n = Math.sqrt(n) || 1;
    for (let j = i; j < i + 4; j++) qo[j] /= n;
  }
}

/** Max effort of the muscles acting on each segment (dofs whose child is the segment). */
export function segmentEffort(a: World['athletes'][number]): Float32Array {
  const out = new Float32Array(a.plan.segments.length);
  let k = 0;
  for (const j of a.plan.joints) {
    const si = a.segIndex.get(j.child)!, pi = a.segIndex.get(j.parent)!;
    for (let d = 0; d < j.dofs.length; d++, k++) {
      const e = a.muscles.effort[k];
      if (e > out[si]) out[si] = e;
      if (e > out[pi]) out[pi] = e * 0.8;
    }
  }
  return out;
}
