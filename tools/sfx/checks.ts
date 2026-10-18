// Rules every library file must pass. Used by the build (fails the build) and by tests/sfx.test.ts.
import { BAND_EDGES, type Stats } from './dsp';
import { PACKS, type Kind } from './library';

export interface Variant { id: string; file: string; source: string; license: string; duration: number; note: string }
export interface Manifest { version: number; categories: { id: string; label: string; group: string; event: string; variants: Variant[] }[] }
/** Measured on the decoded .ogg (round trip), keyed by variant id. */
export type Analysis = Record<string, Stats & { kind: Kind }>;

/** Channels, sample rate and exact length in samples (last page granule position) from Ogg/Vorbis bytes. */
export function oggInfo(b: Uint8Array) {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const id = buf.indexOf(Buffer.from('\x01vorbis', 'latin1')), last = buf.lastIndexOf(Buffer.from('OggS', 'latin1'));
  if (buf.toString('latin1', 0, 4) !== 'OggS' || id < 0) throw new Error('not an Ogg Vorbis file');
  return { channels: buf[id + 11], rate: buf.readUInt32LE(id + 12), samples: Number(buf.readBigUInt64LE(last + 6)) };
}

const LIMITS:Record<Kind, { min: number; max: number; onset: number }> = {
  oneshot: { min: 0.015, max: 1.2, onset: 0.01 },
  long: { min: 1, max: 4, onset: 0.4 },
  loop: { min: 4, max: 10, onset: 0.05 },
};
/** Feature vector for "variants differ": log centroid, duration, band-energy shares, energy-over-time shares. */
const features = (s: Stats) => [Math.log2(Math.max(s.centroid, 20)), s.duration * 4, ...s.bands.map((b) => Math.sqrt(b) * 2), ...s.segments.map((e) => Math.sqrt(e))];

export function checkLibrary(m: Manifest, a: Analysis): string[] {
  const err: string[] = [];
  if (m.version !== 1) err.push('manifest version must be 1');
  const seen = new Set<string>();
  for (const c of m.categories) {
    if (!/^[a-z0-9_]+$/.test(c.id) || seen.has(c.id)) err.push(`bad or duplicate category id ${c.id}`);
    seen.add(c.id);
    if (!c.label || !c.group || !c.event) err.push(`${c.id}: label, group and event are required`);
    if (c.variants.length < 8 || c.variants.length > 16) err.push(`${c.id}: ${c.variants.length} variants (want 8-16)`);
    c.variants.forEach((v, i) => {
      const nn = String(i + 1).padStart(2, '0'), s = a[v.id];
      if (v.id !== `${c.id}_${nn}` || v.file !== `${c.id}/${nn}.ogg`) err.push(`${v.id}: id/file must be ${c.id}_${nn} and ${c.id}/${nn}.ogg`);
      if (v.source !== 'synth' && !PACKS.includes(v.source)) err.push(`${v.id}: unknown source ${v.source}`);
      if (v.license !== 'CC0') err.push(`${v.id}: license must be CC0`);
      if (!v.note) err.push(`${v.id}: missing note`);
      if (!s) { err.push(`${v.id}: no analysis`); return; }
      const lim = LIMITS[s.kind];
      if (Math.abs(s.duration - v.duration) > 0.01) err.push(`${v.id}: manifest duration ${v.duration} != decoded ${s.duration}`);
      if (s.duration < lim.min || s.duration > lim.max) err.push(`${v.id}: duration ${s.duration.toFixed(3)} s outside ${lim.min}-${lim.max}`);
      if (s.clipped > 0 || s.peak > 0.97) err.push(`${v.id}: clipping (peak ${s.peak.toFixed(3)}, ${s.clipped} clipped samples)`);
      if (s.peak < 0.05 || s.momentaryDb < -32) err.push(`${v.id}: too quiet / silent (peak ${s.peak.toFixed(3)}, loudest 50 ms ${s.momentaryDb.toFixed(1)} dB)`);
      if (s.onset > lim.onset) err.push(`${v.id}: starts late (${(s.onset * 1000).toFixed(0)} ms of leading silence)`);
      if (s.kind === 'loop' && s.loopJump > 8) err.push(`${v.id}: loop seam jump ${s.loopJump.toFixed(1)}x the typical sample step`);
      if (s.bands.length !== BAND_EDGES.length - 1 || s.segments.length !== 8) err.push(`${v.id}: bad band/segment count`);
    });
    for (let i = 0; i < c.variants.length; i++) for (let j = i + 1; j < c.variants.length; j++) {
      const p = a[c.variants[i].id], q = a[c.variants[j].id];
      if (!p || !q) continue;
      const fp = features(p), fq = features(q), d = Math.hypot(...fp.map((x, k) => x - fq[k]));
      if (d < 0.05) err.push(`${c.id}: variants ${i + 1} and ${j + 1} are near-identical (feature distance ${d.toFixed(3)})`);
    }
  }
  const ids = new Set(m.categories.flatMap((c) => c.variants.map((v) => v.id)));
  for (const k of Object.keys(a)) if (!ids.has(k)) err.push(`analysis has unknown variant ${k}`);
  return err;
}
