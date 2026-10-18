// Prints the standard-detail body plan (segment origins = proximal joint centres, collision geoms) and the team
// colours as JSON for the Blender character scripts. Run: npx tsx art/tools/dump-body.ts > art/tools/body.json
import { buildBody, DEFAULT_ATHLETE } from '../../src/sim/anatomy/body';
import { TEAMS } from '../../src/game/render/athleteMesh';

const plan = buildBody(DEFAULT_ATHLETE, 'standard');
const r = (v: readonly number[]) => v.map((x) => Math.round(x * 1e4) / 1e4);
console.log(JSON.stringify({
  height: DEFAULT_ATHLETE.height,
  segments: plan.segments.map((s) => ({
    name: s.name, parent: s.parent, side: s.side, origin: r(s.origin),
    geoms: s.geoms.map((g) => ({ name: g.name, type: g.type, role: g.role, size: r(g.size), pos: g.pos && r(g.pos), fromto: g.fromto?.map(r) })),
  })),
  teams: [{ name: 'harbor-gulls', colors: TEAMS[0] }, { name: 'ridge-foxes', colors: TEAMS[1] }],
}, null, 1));
