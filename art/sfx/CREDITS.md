# Sound library credits

Dev-only library for choosing the game's sounds (`npm run picker`). It is not part of the production
build and is never deployed. Every file is CC0. Regenerate everything with `npm run sfx:build`
(recipes in `tools/sfx/library.ts`).

## Synthesized (source "synth")

Made from scratch by the offline synthesizer in `tools/sfx/` (noise, oscillators, struck-object modes,
glottal pulses with vowel formants, filters, envelopes, distortion, reverb, seeded variation).
Voices (grunts, exhales, crowds) are synthesized and non-verbal. Released as CC0 with this repository.

## CC0 packs (source = pack name in `manifest.json`)

Pack sounds were decoded with ffmpeg and reshaped (pitch, trimming, filtering, layering with synthesis)
into football-specific variants. Each variant's `note` names the original file.

| Pack (`source`) | Author | Licence | Link |
|---|---|---|---|
| kenney/impact-sounds | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/impact-sounds |
| kenney/rpg-audio | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/rpg-audio |
| kenney/interface-sounds | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| kenney/ui-audio | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/ui-audio |
| opengameart/100-cc0-sfx-rubberduck | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| opengameart/100-cc0-sfx-2-rubberduck | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx-2 |

Credit is not required by CC0; it is given here as thanks.

## Files

- `manifest.json` — categories and variants (shared format read by the picker).
- `analysis.json` — measurements of each decoded file (peak, RMS, loudest 50 ms, onset, spectral
  centroid, band and time energy shares, loop seam), checked by `tests/sfx.test.ts`.
- `<category>/<NN>.ogg` — mono 44.1 kHz Ogg Vorbis. One-shots start on the transient (no leading silence)
  and are normalized so their loudest 50 ms sits near -14 dBFS RMS (UI -18 to -20, crowd -16, loops
  -22 to -24), peaks at or below -1.4 dBFS. Loops are seamless.
