# README images

The images of the root [README](../../README.md): a hero, two diagrams and a short tour of the Home. They share one soft pastel look
and one rule: **what is drawn as the product is the product's own output, and nothing is drawn as the product that the product
does not do.** This page says which part of each image is which, and how to make them again.

## What is real in each image

| Image | What it is | What is the application's and what is ours |
|---|---|---|
| `relavium-hero.png` | The title and three mock windows | The chat window is a frame of the application's own chat view (its header, grid, tool rows, busy line, status line and hint) rendered through the test harness for a scripted sample session: **the words of the conversation are a sample**, the view is real. The YAML is the shape of a real workflow (`release-notes`, with a human gate). The Runs rows use the Runs screen's real format with sample ids. |
| `agent-to-workflow.png` | The continuum: session, proven flow, workflow file, runs | An illustration. Its small panels use the product's own formats (tool rows, `nodes:`, run rows) and are not captures. |
| `relavium-architecture.png` | The shared-engine topology | An illustration of [the architecture](../../docs/architecture/). The `published` and `planned` chips follow the README's status table: only the CLI is published. |
| `home-tour.gif` | A first run, the palette, `/run`, the confirmation, the Runs screen | **Real frames** of the development build's Home (the v0.2.0 work, not what `npm install` gives today), captured from the built CLI in tmux with a clean `HOME` and the key-less `hello-pipeline` workflow. The text and its layout are the application's. The colours are this theme's, and the captions and their numbers are ours. Run ids are whatever the run produced. |

None of it is a recording of a person: the typing in the GIF is the real keys of a script, sent at a steady pace.

## The look

- **Pastel, flat, calm.** A light lavender page, white windows with a hairline border, soft shadows, ink that is a muted violet-grey and
  never black, and accents from one family (lavender, mint, peach, sky, rose). No glow, no neon, no gradient on a window. Every image
  carries its own background, so it reads the same on a light and a dark page.
- **Colour has the application's meaning where the application gives one**: its cyan is the periwinkle blue, its dim cyan the lavender
  of the wordmark and the rails, its yellow the amber of a tool row, its dim the muted grey, its inverse the lavender band of a
  selected row. The application draws very little colour, so the theme adds **tints for the marks it draws** (`✓` mint, `◉` and `›` lavender,
  `○` faint, `▸` amber) and a small pill behind a `[Key]` token. These tints are design, not product output.
- **Every cell is on the grid.** A terminal cell is drawn on a box of one column wherever a font would draw it wider or narrower
  (the spinner's braille cell, for one), so the columns of a frame stay where the application put them.

## Making them again

Needs `node` and a Chromium-based browser (Brave, Chrome or Chromium; set `RELAVIUM_ASSET_BROWSER` to name one). Nothing is installed.

```bash
node assets/readme/src/build.mjs stills                    # the hero and the two diagrams, from src/frames/chat-frames.json
node assets/readme/src/build.mjs home-gif --from-frames    # the tour, from the frames committed in src/frames/home-tour.json
```

A fresh capture of the Home drives the real application, so it needs the built CLI and tmux:

```bash
pnpm --filter relavium run build
node assets/readme/src/build.mjs home-gif                  # captures, rewrites src/frames/home-tour.json, builds the GIF
```

The chat frames come from the application's chat view through its test harness. `src/capture-chat-frames.test.tsx` is not part of the
suite; run it with a vitest config whose `root` is `apps/cli` and whose `include` names that file (a config that merges the repository's
`vitest.config.ts` and sets `test.include`, then `npx vitest run --config <that file> chat-frames` from `apps/cli`).

**The browser profile.** A brand new profile directory gave no screenshot at all in over six minutes (headless Brave, measured); after the
browser had been started once in it and stopped, screenshots take about a second. The build does that start-and-stop itself the first time
it sees a profile directory that does not exist (about fifteen seconds), so the first build from nothing took 31 seconds for all four images.
`RELAVIUM_ASSET_PROFILE` names the profile directory to keep between builds; the default is one under the system's temporary folder.

The GIF encoder (`src/gif.mjs`) is written here because nothing was to be installed: one global palette, each frame stored as the
rectangle that changed, LZW. `src/gif-verify.mjs` is an independent reader that decodes a GIF and compares every frame with the
screenshot it came from (`node src/gif-verify.mjs <gif> <directory of f0.png, f1.png, …>`); the GIF in this directory was also decoded
frame by frame by a browser's own decoder.

## What the tour does not show, on purpose

The `/workflows` popup is not a frame of the tour: with a run in the strip, the Home's dimmed backdrop leaves the tail of its hint
(`wice)` of `exit (twice)`) beside the popup's box, which reads as a glitch in a still. It is a faithful frame of the application and is
recorded in [the review follow-ups](../../docs/roadmap/deferred-tasks.md#mvp-11-pr-103-review-follow-ups-2026-11-28).
