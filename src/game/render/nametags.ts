// Multiplayer name tags (owner request 2026-10-19): a small label over each athlete's head, the player's name for a
// person and BOT for a bot, so everyone sees who is who. Sprites a fixed size on screen (readable at any distance),
// drawn on top, unlit; none in single player. Visual only.
import * as THREE from 'three';

/** Height over the head segment's origin (m): above the helmet. */
const ABOVE = 0.55;
/** On-screen size (sprite scale with sizeAttenuation off: fraction of the view's height). */
const H = 0.032;

export interface Tag { text: string; bot: boolean; team: 0 | 1 }

export class NameTags {
  readonly root = new THREE.Group();
  private sprites: (THREE.Sprite | null)[] = [];
  private key = '';

  /** One tag per athlete (null: none, e.g. the local player's own). Rebuilt only when the labels change. */
  set(tags: (Tag | null)[]) {
    const key = JSON.stringify(tags);
    if (key === this.key) return;
    this.key = key;
    for (const s of this.sprites) if (s) { this.root.remove(s); (s.material as THREE.SpriteMaterial).map?.dispose(); s.material.dispose(); }
    this.sprites = tags.map((t) => (t ? this.sprite(t) : null));
    for (const s of this.sprites) if (s) this.root.add(s);
  }

  /** Place the tags over the heads (segment positions, flat xyz per segment) of the athletes this frame. */
  update(heads: (ArrayLike<number> | null)[]) {
    this.sprites.forEach((s, i) => {
      const h = heads[i];
      if (!s) return;
      s.visible = !!h;
      if (h) s.position.set(h[0], h[1] + ABOVE, h[2]);
    });
  }

  private sprite(t: Tag): THREE.Sprite {
    const c = document.createElement('canvas'), g = c.getContext('2d')!, px = 44;
    g.font = `700 ${px}px system-ui, sans-serif`;
    const w = Math.ceil(g.measureText(t.text).width) + 36;
    c.width = w; c.height = px + 22;
    g.font = `700 ${px}px system-ui, sans-serif`;
    // a person: his team's colour; a bot: grey, so the two read apart at a glance
    g.fillStyle = t.bot ? 'rgba(60,60,60,0.82)' : t.team === 0 ? 'rgba(24,52,120,0.9)' : 'rgba(200,90,20,0.9)';
    const r = c.height / 2;
    g.beginPath(); g.roundRect(0, 0, w, c.height, r); g.fill();
    g.fillStyle = t.bot ? '#d8d8d8' : '#ffffff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t.text, w / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true, fog: false }));
    s.scale.set(H * w / c.height, H, 1);
    s.renderOrder = 20;
    return s;
  }
}
