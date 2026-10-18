// Three.js view of a World. Reads physics state only; never writes it.
import * as THREE from 'three';
import type { World } from '../../sim/world';
import { AthleteMesh, TEAMS } from './athleteMesh';
import { AnatomyOverlay } from './anatomy';
import { buildBarrier, buildField } from './field';
import { loadStadium, OPEN_FIELD, stadiumById, type Stadium, type StadiumScene } from './stadium';
import { CLASSIC, loadSkin, skinById, type Skin, type SkinTemplate } from './skin';

export interface RenderQuality { scale: number; shadows: boolean; detail: 'low' | 'high'; antialias: boolean }
export const RENDER_PRESETS: Record<'minimum' | 'high', RenderQuality> = {
  minimum: { scale: 0.6, shadows: false, detail: 'low', antialias: false },
  high: { scale: 1, shadows: true, detail: 'high', antialias: true },
};

/** The Open Field's sky and light (what the renderer starts with). */
const OPEN_SCENE: StadiumScene = { sky: '#9cc3e4', fog: ['#9cc3e4', 80, 220], hemi: ['#dfeeff', '#3c5a2c', 1.1], sun: ['#ffffff', 2.2] };

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
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
  /** Render time of the last frame (ms) and the last frame's draw calls. */
  lastMs = 0;

  constructor(canvas: HTMLCanvasElement, public quality: RenderQuality) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.scale);
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x9cc3e4);
    this.scene.fog = new THREE.Fog(0x9cc3e4, 80, 220);
    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x3c5a2c, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(-20, 40, 15);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.normalBias = 0.02; // no self-shadow acne on the skins' faceted and cel-shaded surfaces
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 100;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(buildField(quality.detail));
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
    for (const a of this.athletes) this.scene.remove(a.root);
    this.athletes = w.athletes.map((a) => new AthleteMesh(a.plan, TEAMS[a.setup.team], this.quality.detail, this.template));
    for (const a of this.athletes) { a.setXray(this.xray); this.scene.add(a.root); }
  }

  setWorld(w: World) {
    this.world = w;
    for (const p of this.props) this.scene.remove(p);
    if (this.overlay) this.scene.remove(this.overlay.root);
    this.dress(w);
    this.props = (w.setup.props ?? []).map((p) => {
      if (p.hidden) return new THREE.Object3D(); // a collision wall: the stadium draws it (kept so prop indices line up)
      const geo = p.shape === 'box' ? new THREE.BoxGeometry(2 * p.size[0], 2 * p.size[1], 2 * p.size[2])
        : p.shape === 'capsule' ? new THREE.CapsuleGeometry(p.size[0], 2 * p.size[1], 4, 10)
        : new THREE.SphereGeometry(1, 16, 12).scale(p.size[0], p.size[1], p.size[2]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.mass > 0 && p.mass < 1 ? 0x7a3b16 : 0xc8462b, roughness: 0.8 }));
      mesh.castShadow = true;
      mesh.position.set(...p.pos);
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

  render(w: World) {
    if (w !== this.world) return; // a new rep whose skin is still loading
    const t0 = performance.now();
    w.athletes.forEach((a, i) => {
      const s = w.scene.athletes[i].state, mesh = this.athletes[i];
      mesh.pose(s.segPos, s.segQuat);
      mesh.setHeadVisible(i !== this.hideHeadOf);
      mesh.shade(this.xray && this.effortShading ? segmentEffort(a) : null);
    });
    (w.setup.props ?? []).forEach((p, i) => {
      if (p.mass <= 0) return;
      const { pos, quat } = w.scene.propPose(i);
      this.props[i].position.set(...pos);
      this.props[i].quaternion.set(...quat);
    });
    if (this.overlay?.root.visible) this.overlay.update(w);
    // keep the shadow camera on the action
    const c = w.scene.athletes[0].state.com;
    this.sun.target.position.set(c[0], 0, c[2]);
    this.sun.position.set(c[0] - 20, 40, c[2] + 15);
    this.renderer.render(this.scene, this.camera);
    this.lastMs = performance.now() - t0;
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
