# Vaulted QB throw schemes

Owner decision 2026-10-19: Placement reticle is the only QB throw control. The other five schemes (Aim & charge,
Target lock, Bullet / lob buttons, Flick, Auto QB) are kept here unchanged but are not built, type-checked or tested
(tsconfig excludes this folder) and are not maintained.

- `schemes-all.ts` is the six-scheme module as it was (with its Passer that switched between them).
- Its tests and the switching UI (keys 1–6 / V, the Settings choice, the lob / next-receiver keys) are in git history:
  commit a09b22f (`tests/passing-schemes.test.ts`, `tests/e2e/passing.spec.ts`, `src/game/main.ts`
  passFrame / switchScheme, `src/game/settings-menu.ts`).

To bring one back: copy its function into `../schemes.ts`, add it to the Passer, and restore its tests.
