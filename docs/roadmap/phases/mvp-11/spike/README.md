# MVP-11 Step 1 spike kit

Throwaway scripts for the real-terminal check that [MVP-11 Step 1](../../mvp-11.md#step-1--decisions-adrs-spike-and-baseline) asks for. They are **not product code** (nothing under `apps/` or `packages/` imports them), they draw a prototype with the CLI's own Ink, and the results so far are written into the Step 1 text of the MVP. Run them on a terminal and the machine you want evidence for.

**Setup, once** (needs `pnpm install` at the repository root):

```bash
cd docs/roadmap/phases/mvp-11/spike
ln -sfn ../../../../../apps/cli/node_modules node_modules
```

## 1. Glyph widths, in any terminal (about 10 seconds)

```bash
node spike-widths.mjs --out widths-<terminal-name>.txt
```

It prints each glyph of the visual language, asks the terminal where the cursor is, and compares the answer with the width the renderer assumes. Send back the `SUMMARY` line and every line marked `DIFFERS`.

## 2. The popup, by hand, in any terminal (about 2 minutes)

```bash
node spike-render.mjs            # full screen; also try:  node spike-render.mjs --inline
```

`o` opens the popup, `Esc` closes it, `s` toggles a later sibling that covers popup rows, `q` quits. Look for:

1. the popup is centred, its border is straight and **no body text shows inside it**;
2. the text behind it is dimmed;
3. `Esc` leaves **nothing** of the popup behind;
4. `s` shows the covering sibling on top of the popup (that is the hazard the occlusion test guards against);
5. drag the window larger (the popup re-centres), then smaller than 80×24 (a notice replaces it), then back;
6. `q` returns to a shell whose earlier output is intact; with `--inline`, scroll up and check the output from before the run is still there.

Say which terminal, its version, and anything that looks wrong (a shifted right border, a row that is not dimmed, leftovers).

## 3. Automated, inside tmux (about 2 minutes)

A private tmux server is used (its own socket), so an existing tmux is not touched.

```bash
node run-tmux.mjs            # 15 checks of the full-screen popup, cell for cell against a model
node run-tmux-inline.mjs     # the inline form and the scrollback
node run-threshold.mjs       # the live-region height at which the scrollback is lost
node run-tmux.mjs --no-dim   # control: fails only the dimming check
node run-tmux.mjs --leaky    # control: fails the opacity checks
SPIKE_W=78 SPIKE_H=23 node run-tmux.mjs   # the large inspection popup
```

## 4. The measured-frame check, as a unit test

The test is stored as `popup-bounds.spike.txt` on purpose: under its real name a repository-wide Vitest run would collect it from here. Copy it to `apps/cli/src/render/tui/zz-popup-bounds.spike.test.tsx`, run `pnpm --filter relavium exec vitest run src/render/tui/zz-popup-bounds.spike.test.tsx`, and delete the copy. It runs the repository's own `fitsTerminalBounds` and `createMeasuredFrameAcknowledgement` against an absolutely positioned popup and against a later sibling that covers it.
