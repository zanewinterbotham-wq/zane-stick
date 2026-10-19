// The football AI layer (docs/passing.md "AI built for 11 on 11"): a play call gives every athlete an assignment as
// data, and the brains (QB, receiver, defensive back, later linemen) play it reading the whole field. Nothing here
// assumes how many athletes there are: the QB 1-on-1 mode is one play call of three assignments.

/** Where the play is: line of scrimmage (world z, m), the way the offense attacks (+1 / −1 along z), the field's
 *  half width (m), and the snap (sim time, s). Depth is measured downfield from the LOS; x is world x. */
export interface PlayFrame { los: number; dir: 1 | -1; halfWidth: number; snapTime: number }

/** The route tree (route depth in m downfield; 'option' routes break by the coverage: away from man leverage, sit
 *  down in a zone hole). */
export type RouteKind = 'go' | 'slant' | 'out' | 'in' | 'dig' | 'curl' | 'comeback' | 'hitch' | 'post' | 'corner' | 'seam' | 'flat' | 'wheel' | 'screen';
export interface RouteAssign { kind: 'route'; route: RouteKind; depth?: number; option?: boolean; release?: 'outside' | 'inside' | 'auto' }
/** One read of a QB progression: the target athlete, an optional defender whose leverage keys it, and the time
 *  after the snap (s) by which the QB moves on. */
export interface Read { target: number; key?: number; by: number }
export interface PassAssign { kind: 'pass'; drop: 0 | 3 | 5 | 7; reads: Read[]; hot?: number; checkdown?: number; scramble: boolean }
export interface ManAssign { kind: 'man'; target: number; press: boolean; leverage: 'inside' | 'outside'; help: 'deep' | 'inside' | 'none' }
export type ZoneKind = 'flat' | 'hook' | 'curl' | 'deep-third' | 'deep-half' | 'deep-quarter' | 'middle';
/** side: which part of the field (+1 the left of the offense's view, −1 the right, 0 the middle). */
export interface ZoneAssign { kind: 'zone'; zone: ZoneKind; side: -1 | 0 | 1 }
export interface BlockAssign { kind: 'block'; target?: number }
export interface RushAssign { kind: 'rush'; lane?: number }
export interface RunAssign { kind: 'run' }
export type Assignment = RouteAssign | PassAssign | ManAssign | ZoneAssign | BlockAssign | RushAssign | RunAssign;

/** A play: its frame, the team on offense, and an assignment per athlete index (null: none, e.g. a human). */
export interface PlayCall { frame: PlayFrame; offense: 0 | 1; assign: (Assignment | null)[] }
