// Regulation field: 120 yd × 53⅓ yd including end zones, yard lines every 5 yd, hash marks, numbers.
import * as THREE from 'three';
import { BARRIER } from '../../sim/drills/openField';

export const YD = 0.9144;
export const FIELD = { length: 120 * YD, width: (160 / 3) * YD };

export function buildField(quality: 'low' | 'high'): THREE.Group {
  const g = new THREE.Group();
  const tex = fieldTexture(quality === 'high' ? 4096 : 2048);
  const turf = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.width + 12, FIELD.length + 12), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  turf.rotation.x = -Math.PI / 2;
  turf.receiveShadow = true;
  g.add(turf);
  return g;
}

/** The Open Field's padded wall, on the physics barrier (the stadium models draw their own). */
export function buildBarrier(): THREE.Group {
  const g = new THREE.Group();
  const { halfWidth: hw, halfLength: hl } = BARRIER, h = 1.3, t = 0.5;
  const pad = new THREE.MeshStandardMaterial({ color: 0x1f3a68, roughness: 0.9 }), trim = new THREE.MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.9 });
  const add = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    g.add(m);
  };
  for (const s of [-1, 1]) {
    add(pad, s * (hw + t / 2), h / 2, 0, t, h, 2 * hl + 2 * t); add(trim, s * (hw + t / 2), h + 0.04, 0, t + 0.04, 0.08, 2 * hl + 2 * t);
    add(pad, 0, h / 2, s * (hl + t / 2), 2 * hw + 2 * t, h, t); add(trim, 0, h + 0.04, s * (hl + t / 2), 2 * hw + 2 * t, 0.08, t + 0.04);
  }
  return g;
}

/** Field painted on a canvas; +Z goes toward the far end zone (field length along Z). */
function fieldTexture(px: number): THREE.CanvasTexture {
  const W = FIELD.width + 12, L = FIELD.length + 12; // metres incl. 6 m apron each side
  const c = document.createElement('canvas');
  c.width = Math.round(px * (W / L)); c.height = px;
  const ctx = c.getContext('2d')!;
  const sx = c.width / W, sy = c.height / L;
  const X = (m: number) => (m + W / 2) * sx, Y = (m: number) => (L / 2 - m) * sy;
  ctx.fillStyle = '#2f6b33'; ctx.fillRect(0, 0, c.width, c.height);
  // mowing stripes every 5 yd: the mower lays the grass toward or away from the eye, so alternate bands read light and
  // dark; each band is a little lighter at one edge, like a rolled lawn
  for (let yd = -60; yd < 60; yd += 5) {
    const y0 = Y((yd + 5) * YD), h = 5 * YD * sy, light = (yd / 5) % 2 === 0;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, light ? '#3d853f' : '#2b6230'); g.addColorStop(1, light ? '#367a3a' : '#2f6b33');
    ctx.fillStyle = g;
    ctx.fillRect(X(-FIELD.width / 2), y0, FIELD.width * sx, h);
  }
  // grass grain: fine light and dark flecks (seeded, so the turf is the same every time)
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < (c.width * c.height) / 250; n++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,20,0,0.06)';
    ctx.fillRect(rnd() * c.width, rnd() * c.height, 1 + rnd() * 2, 2 + rnd() * 4);
  }
  // end zones
  ctx.fillStyle = '#1f3a68'; ctx.fillRect(X(-FIELD.width / 2), Y(60 * YD), FIELD.width * sx, 10 * YD * sy);
  ctx.fillStyle = '#c4561a'; ctx.fillRect(X(-FIELD.width / 2), Y(-50 * YD), FIELD.width * sx, 10 * YD * sy);
  ctx.strokeStyle = '#f4f4ee'; ctx.fillStyle = '#f4f4ee';
  const line = (x0: number, z0: number, x1: number, z1: number, w: number) => { ctx.lineWidth = w * sx; ctx.beginPath(); ctx.moveTo(X(x0), Y(z0)); ctx.lineTo(X(x1), Y(z1)); ctx.stroke(); };
  // boundary (6 ft wide border in white, here 0.1 m lines)
  line(-FIELD.width / 2, -60 * YD, -FIELD.width / 2, 60 * YD, 0.15); line(FIELD.width / 2, -60 * YD, FIELD.width / 2, 60 * YD, 0.15);
  line(-FIELD.width / 2, -60 * YD, FIELD.width / 2, -60 * YD, 0.15); line(-FIELD.width / 2, 60 * YD, FIELD.width / 2, 60 * YD, 0.15);
  for (let yd = -50; yd <= 50; yd += 5) line(-FIELD.width / 2, yd * YD, FIELD.width / 2, yd * YD, 0.1);
  // hash marks (college width 40 ft apart) and sideline ticks every yard
  const hash = (40 / 3) * YD / 2 * 1.0;
  for (let yd = -49; yd <= 49; yd++) {
    if (yd % 5 === 0) continue;
    for (const x of [-hash, hash]) line(x - 0.3, yd * YD, x + 0.3, yd * YD, 0.05);
    for (const x of [-FIELD.width / 2 + 0.2, FIELD.width / 2 - 0.2]) line(x - 0.3, yd * YD, x + 0.3, yd * YD, 0.05);
  }
  // numbers every 10 yd
  ctx.font = `bold ${Math.round(1.8 * sy)}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let yd = -40; yd <= 40; yd += 10) {
    const n = String(50 - Math.abs(yd));
    for (const [x, rot] of [[-FIELD.width / 2 + 8, -Math.PI / 2], [FIELD.width / 2 - 8, Math.PI / 2]] as const) {
      ctx.save(); ctx.translate(X(x), Y(yd * YD)); ctx.rotate(rot); ctx.fillText(n, 0, 0); ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
