// Kickoff return: the bots kick off from their 35 (NFL), deep to you. Field it, follow your blockers and take it
// back. Caught in the end zone you may down it (stay on the turf, or run out of the back) for a touchback.
import { kickDistance, kickoffPlay } from './kickoff';
import type { ModeDef } from './types';

export const KICKOFF_RETURN: ModeDef = {
  id: 'kickoffReturn', title: 'Kickoff Return', preview: 'modes/kickoffReturn.jpg',
  pitch: 'The kick is coming deep to you. Field it, follow your blockers through the coverage and take it to the house.',
  options: [
    { id: 'block', label: 'Your blockers', kind: 'range', min: 0, max: 4, step: 1, default: 1 },
    { id: 'cover', label: 'Their coverage (the kicker too)', kind: 'range', min: 1, max: 5, step: 1, default: 2 },
    kickDistance,
  ],
  athletes: (o) => 1 + +o.block + +o.cover,
  setup: (o, rng) => kickoffPlay(1, +o.cover, +o.block, +o.distance, rng),
};
