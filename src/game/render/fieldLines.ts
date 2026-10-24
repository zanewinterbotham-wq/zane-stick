// TV-style field lines: the blue line of scrimmage and the yellow first-down line, flat on the turf from sideline to
// sideline. Depth-tested with a polygon offset (above the stadium's field paint, no z-fighting), so players cover them.
import * as THREE from 'three';
import type { FieldLines } from '../../sim/modes/types';

const WIDTH = 0.3; // m along the field
const mat = (color: number) => new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -32 });

export class FieldLinesView {
  readonly root = new THREE.Group();
  private readonly scrimmage = new THREE.Mesh(new THREE.PlaneGeometry(1, WIDTH), mat(0x1e63ff));
  private readonly firstDown = new THREE.Mesh(new THREE.PlaneGeometry(1, WIDTH), mat(0xffe21a));
  constructor() {
    for (const m of [this.scrimmage, this.firstDown]) { m.rotation.x = -Math.PI / 2; m.position.y = 0.01; m.visible = false; m.renderOrder = 1; this.root.add(m); }
  }
  /** Put the lines at the given z (m), as wide as the field (`halfWidth` m each side); a missing line is hidden. */
  set(l: FieldLines, halfWidth: number) {
    for (const [m, z] of [[this.scrimmage, l.scrimmage], [this.firstDown, l.firstDown]] as const) {
      m.visible = z !== undefined;
      if (z !== undefined) { m.position.z = z; m.scale.x = 2 * halfWidth; }
    }
  }
}
