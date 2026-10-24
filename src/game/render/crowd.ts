// The crowd in the stadium models is one mesh of sprites on the seats (the `*_crowd` material). Here its vertex shader
// is given a gentle sway, hops when something big happens and a "wave" of fans standing up round the bowl on a score.
// Presentation only: a few uniforms, no extra draw calls. (No new sounds: the owner rejected synthesised cheers twice and the
// CC0 packs have none; the picked crowd_ooh plays on big hits.)
import * as THREE from 'three';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Seconds a big play's hops fade over, and how long a score's wave runs. */
export const CHEER_FADE = 2.4, WAVE_TIME = 7;

/** The crowd's mood: hops (0..1, decaying) and the wave (0..1, held then fading), advanced by frame time. */
export class CrowdFx {
  cheer = 0;
  wave = 0;
  time = 0;
  private waveLeft = 0;

  /** Something big (a hard hit): the fans hop, harder for a bigger `k` (0..1). */
  react(k: number) { this.cheer = Math.max(this.cheer, clamp01(k)); }
  /** A score: everyone hops and the wave goes round. */
  celebrate() { this.cheer = 1; this.waveLeft = WAVE_TIME; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.cheer = Math.max(0, this.cheer - dt / CHEER_FADE);
    this.waveLeft = Math.max(0, this.waveLeft - dt);
    this.wave = clamp01(Math.min(this.waveLeft, 1)); // eased out over the last second
  }
}

/** Uniforms shared by every patched crowd material (one stadium is on screen at a time). */
export const crowdUniforms = { uTime: { value: 0 }, uCheer: { value: 0 }, uWave: { value: 0 } };

export function pushUniforms(c: CrowdFx) {
  crowdUniforms.uTime.value = c.time; crowdUniforms.uCheer.value = c.cheer; crowdUniforms.uWave.value = c.wave;
}

const GLSL = /* glsl */ `
  uniform float uTime; uniform float uCheer; uniform float uWave;
  float crowdLift(vec3 p) {
    float cell = floor(p.x * 1.6) + floor(p.z * 1.6) * 7.0;
    float h = fract(sin(cell * 12.9898) * 43758.5453);
    float sway = 0.012 * sin(uTime * 1.3 + h * 6.283);
    float hop = abs(sin(uTime * (6.0 + 3.0 * h) + h * 6.283)) * uCheer * (0.10 + 0.14 * h);
    float ang = atan(p.z, p.x);
    float stand = smoothstep(0.55, 0.95, sin(ang * 2.0 - uTime * 1.6)) * uWave * 0.32;
    return sway + hop + stand;
  }`;

/** Make a stadium's crowd material move. Safe to call on any material; the shader change is the same for all of them. */
export function patchCrowd(mat: THREE.Material) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, crowdUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${GLSL}\nvoid main() {`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed.y += crowdLift(position);');
  };
  mat.customProgramCacheKey = () => 'crowd';
  mat.needsUpdate = true;
}
