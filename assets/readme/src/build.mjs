#!/usr/bin/env node
// Builds the README's images. See ../README.md for what is real in them and what is not.
//
//   node assets/readme/src/build.mjs stills                    the hero, the continuum and the architecture (PNG, 1.5x)
//   node assets/readme/src/build.mjs home-gif                  drives the built CLI in tmux, captures the Home, writes home-tour.gif
//   node assets/readme/src/build.mjs home-gif --from-frames    the same GIF from the frames committed in src/frames (no CLI, no tmux)
//   node assets/readme/src/build.mjs all
//
// Needs: node, a Chromium-based browser (Brave, Chrome or Chromium; RELAVIUM_ASSET_BROWSER names one), and for a fresh capture
// `pnpm --filter relavium run build` and tmux. Nothing is installed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAnsi } from './ansi.mjs';
import { frameHtml } from './frame-html.mjs';
import { encodeGif } from './gif.mjs';
import { decodePng } from './png.mjs';
import { shoot } from './shoot.mjs';
import { architectureHtml, flowHtml, heroHtml } from './static-pages.mjs';
import { runScenario } from './tmux-drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const outDir = resolve(here, '..');
const framesDir = join(here, 'frames');
// A browser profile that has been started once: the first launch in a brand new profile can take a very long time.
const profile =
  process.env.RELAVIUM_ASSET_PROFILE ?? join(tmpdir(), 'relavium-readme-assets-profile');

const mode = process.argv[2] ?? 'all';
const fromFrames = process.argv.includes('--from-frames');

async function stills() {
  const work = mkdtempSync(join(tmpdir(), 'relavium-readme-stills-'));
  const jobs = [
    ['relavium-hero', heroHtml(join(framesDir, 'chat-frames.json')), 1280, 560],
    ['agent-to-workflow', flowHtml(), 1280, 440],
    ['relavium-architecture', architectureHtml(), 1280, 700],
  ];
  for (const [name, html, width, height] of jobs) {
    const page = join(work, `${name}.html`);
    writeFileSync(page, html);
    await shoot(page, join(outDir, `${name}.png`), width, height, profile, 2500, 1.5);
    console.log(`wrote ${name}.png`);
  }
}

// ── the Home tour ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The workflow the tour runs: it needs no provider key (the same file the README shows). */
const HELLO_PIPELINE = `schema_version: '1.0'
workflow:
  id: hello-pipeline
  name: Hello pipeline
  inputs:
    - { name: who, type: string }
    - { name: times, type: number }
  nodes:
    - { id: start, type: input }
    - { id: greet, type: transform, transform: "({ greeting: 'Hello, ' + inputs.who + '!', count: inputs.times * 2 })" }
    - { id: out, type: output }
  edges:
    - { from: start, to: greet }
    - { from: greet, to: out }
`;

// `quiet` steps only drive the program; every other step is a frame of the tour: its story beat (the number in the caption),
// its caption and how long it stays on screen.
const F = (beat, label, wait, caption, delay, keys, text) => ({
  beat,
  label,
  wait,
  caption,
  delay,
  keys,
  text,
});
const quiet = (label, wait, keys, text) => ({ label, wait, keys, text, shoot: false });
const STEPS = [
  F(1, 'first-run', 1500, 'First run: connect a provider, or skip for now', 2400),
  F(2, 'skip', 1400, 'The Home: type to start an agent, or press / for every command', 2400, [
    'Escape',
  ]),
  F(3, 'palette', 900, 'Press / to see every command', 2000, [], '/'),
  F(3, 'p-r', 500, 'It narrows as you type', 650, [], 'r'),
  F(3, 'p-ru', 500, 'It narrows as you type', 650, [], 'u'),
  F(
    3,
    'p-run',
    700,
    '/run picks a workflow, fills in its inputs and asks before it runs',
    1700,
    [],
    'n',
  ),
  F(4, 'run-1', 1300, 'Pick one of this project’s workflows', 1900, ['Enter']),
  F(5, 'run-2', 1300, 'Fill in its inputs', 1300, ['Enter']),
  F(5, 'who-A', 400, 'Fill in its inputs', 420, [], 'A'),
  F(5, 'who-Ad', 400, 'Fill in its inputs', 420, [], 'd'),
  F(5, 'who-Ada', 500, 'Fill in its inputs', 900, [], 'a'),
  F(5, 'times-0', 1000, 'Fill in its inputs', 1000, ['Enter']),
  F(5, 'times-3', 500, 'Fill in its inputs', 900, [], '3'),
  F(6, 'confirm-wait', 1200, 'Confirm: the answer key waits a moment before it opens', 1700, [
    'Enter',
  ]),
  F(6, 'confirm-open', 2500, 'Then Ctrl+Y starts it, Ctrl+N cancels, Esc goes back', 2300),
  F(7, 'started', 3300, 'Started: the run is kept as a record you can open later', 2400, ['C-y']),
  quiet('settle', 3500),
  quiet('wf-type', 700, [], '/workflows'),
  quiet('wf-open', 1300, ['Enter']),
  F(
    8,
    'runs',
    1500,
    '/workflows, then h: every finished run, newest first. Enter opens one',
    4200,
    [],
    'h',
  ),
];

async function captureHome() {
  const cli = join(repo, 'apps/cli/dist/index.js');
  if (!existsSync(cli)) throw new Error('build the CLI first: pnpm --filter relavium run build');
  const run = mkdtempSync(join(tmpdir(), 'relavium-readme-home-'));
  const home = join(run, 'home');
  const project = join(home, 'acme-app');
  mkdirSync(join(project, '.relavium', 'workflows'), { recursive: true });
  writeFileSync(
    join(project, '.relavium', 'workflows', 'hello-pipeline.relavium.yaml'),
    HELLO_PIPELINE,
  );
  const frames = await runScenario({
    socket: 'relavium-readme',
    cwd: project,
    env: { HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    command: [process.execPath, cli],
    cols: 80,
    rows: 24,
    outDir: join(run, 'frames'),
    steps: STEPS,
  });
  const saved = frames.map(({ name, ansi, step }) => ({
    name,
    ansi,
    beat: step.beat,
    caption: step.caption,
    delay: step.delay,
  }));
  writeFileSync(join(framesDir, 'home-tour.json'), `${JSON.stringify(saved, null, 1)}\n`);
  return saved;
}

async function homeGif() {
  const frames = fromFrames
    ? JSON.parse(readFileSync(join(framesDir, 'home-tour.json'), 'utf8'))
    : await captureHome();
  const W = 900;
  const H = 672;
  const work = mkdtempSync(join(tmpdir(), 'relavium-readme-gif-'));
  const images = [];
  const delays = [];
  for (const [n, f] of frames.entries()) {
    const html = join(work, `f${n}.html`);
    const png = join(work, `f${n}.png`);
    writeFileSync(
      html,
      frameHtml({
        grid: parseAnsi(f.ansi, 80, 24),
        title: 'relavium',
        caption: { step: f.beat, text: f.caption },
        width: W,
        height: H,
      }),
    );
    await shoot(html, png, W, H, profile);
    images.push(decodePng(readFileSync(png)));
    delays.push(f.delay);
  }
  const gif = encodeGif(images, delays);
  writeFileSync(join(outDir, 'home-tour.gif'), gif);
  console.log(
    `wrote home-tour.gif: ${images.length} frames, ${(gif.length / 1024).toFixed(0)} KiB`,
  );
}

if (mode === 'stills' || mode === 'all') await stills();
if (mode === 'home-gif' || mode === 'all') await homeGif();
if (!['stills', 'home-gif', 'all'].includes(mode)) {
  console.error('usage: build.mjs stills | home-gif [--from-frames] | all');
  process.exitCode = 2;
}
