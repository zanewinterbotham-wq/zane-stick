// Regulation field: 120 yd × 53⅓ yd including end zones, yard lines every 5 yd, hash marks, numbers.
import * as THREE from 'three';

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

/** Field painted on a canvas; +Z goes toward the far end zone (field length along Z). */
function fieldTexture(px: number): THREE.CanvasTexture {
  const W = FIELD.width + 12, L = FIELD.length + 12; // metres incl. 6 m apron each side
  const c = document.createElement('canvas');
  c.width = Math.round(px * (W / L)); c.height = px;
  const ctx = c.getContext('2d')!;
  const sx = c.width / W, sy = c.height / L;
  const X = (m: number) => (m + W / 2) * sx, Y = (m: number) => (L / 2 - m) * sy;
  ctx.fillStyle = '#2f6b33'; ctx.fillRect(0, 0, c.width, c.height);
  // mowing stripes every 5 yd
  for (let yd = -60; yd < 60; yd += 5) {
    ctx.fillStyle = (yd / 5) % 2 === 0 ? '#357439' : '#2f6b33';
    ctx.fillRect(X(-FIELD.width / 2), Y((yd + 5) * YD), FIELD.width * sx, 5 * YD * sy);
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
