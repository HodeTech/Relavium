/**
 * The `/run` workflow list at its narrowest (MVP-11 unit 6, round 2: OB-8): the list says each workflow's file, and the directory every file of
 * the list is in is said by no row, so a name and its file are ONE row at 80 columns (`Conditional branch` and `.relavium/workflows/
 * conditional.relavium.yaml` read as two rows before). Drawn for real at 80×24 on the Home's own channel; what a project wrote still goes through
 * the full scrub.
 */
import { parseWorkflow } from '@relavium/core';
import { afterEach, describe, expect, it } from 'vitest';

import { mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import { createRunLaunch, type LaunchCatalog } from './run-launch.js';

const mounts: HomeMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const workflow = (id: string, name?: string): string => `schema_version: '1.0'
workflow:
  id: ${id}
${name === undefined ? '' : `  name: ${name}\n`}  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** A catalog over workflow texts held in memory, each at the project-relative path it is given. */
function catalogOf(files: Readonly<Record<string, string>>): LaunchCatalog {
  return {
    list: () =>
      Object.entries(files).map(([path, yaml]) => {
        const definition = parseWorkflow(yaml, { source: path });
        return {
          path,
          slug: definition.workflow.id,
          name: definition.workflow.name,
          tags: [],
          valid: true,
        };
      }),
    load: (path) => ({
      definition: parseWorkflow(files[path] ?? '', { source: path }),
      sourceDigest: 'd'.repeat(64),
      fsScope: { tier: 'sandboxed', fromRepository: false },
    }),
  };
}

const DIR = '.relavium/workflows/';
/** The workflows of the observed project (capture `f1-list`), the widest of them first. */
const PROJECT: Readonly<Record<string, string>> = {
  [`${DIR}approval-gate.relavium.yaml`]: workflow('approval-gate', 'Approval gate'),
  [`${DIR}conditional.relavium.yaml`]: workflow('conditional', 'Conditional branch'),
  [`${DIR}failure.relavium.yaml`]: workflow('failure', 'Failing transform'),
  [`${DIR}fan-out.relavium.yaml`]: workflow('fan-out', 'Fan-out / aggregate'),
  [`${DIR}human-gate.relavium.yaml`]: workflow('human-gate', 'Human gate (pause)'),
  [`${DIR}sequential.relavium.yaml`]: workflow('sequential', 'Sequential pipeline'),
  [`${DIR}hello-pipeline.relavium.yaml`]: workflow('hello-pipeline', 'Hello pipeline'),
};

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
function shownNow(m: HomeMount): boolean {
  const channel = m.channel;
  if (channel === undefined) return false;
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

/** The list opened on the Home at 80×24, as the typed `/run` opens it. */
async function listOf(files: Readonly<Record<string, string>>) {
  const m = mountHome(
    { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
    { nativePrompt: true },
  );
  mounts.push(m);
  await m.settle();
  const channel = m.channel;
  if (channel === undefined) throw new Error('no channel');
  const launch = createRunLaunch({
    flow: channel.flow,
    host: { start: () => Promise.reject(new Error('nothing starts')) },
    catalog: catalogOf(files),
  });
  const opened = launch.open();
  await m.until(() => channel.ui.getSnapshot().kind === 'select' && shownNow(m));
  const snapshot = channel.ui.getSnapshot();
  const lines = m.text().split('\n');
  channel.flow.cancel();
  await opened;
  return { snapshot, lines };
}

describe('the /run list says each file once, without the directory they all share', () => {
  it('OB-8 a workflow and its file are ONE row at 80 columns: no row is only a path', async () => {
    const { snapshot, lines } = await listOf(PROJECT);
    expect(snapshot.message).toBe('Run which workflow?');
    for (const [path, yaml] of Object.entries(PROJECT)) {
      const label = /name: (.+)/u.exec(yaml)?.[1] ?? '';
      const file = path.slice(DIR.length);
      const row = lines.find((line) => line.includes(label));
      expect(row, `a row for ${label}`).toBeDefined();
      expect(row, `${label} and ${file} are one row`).toContain(file);
    }
    expect(lines.join('\n'), 'the shared directory is on no row').not.toContain(DIR);
  });

  it('the hint of each choice is its file, the directory they all share left out', async () => {
    const { snapshot } = await listOf(PROJECT);
    expect(snapshot.options.map((option) => option.hint)).toEqual(
      Object.keys(PROJECT).map((path) => path.slice(DIR.length)),
    );
  });

  it('a list of ONE workflow says its file the same way', async () => {
    const only = { [`${DIR}solo.relavium.yaml`]: workflow('solo', 'Solo') };
    const { snapshot } = await listOf(only);
    expect(snapshot.options.map((option) => option.hint)).toEqual(['solo.relavium.yaml']);
  });

  it('files in different places keep what tells them apart: only the directory they ALL share goes', async () => {
    const mixed = {
      [`${DIR}a.relavium.yaml`]: workflow('a-one'),
      [`${DIR}team/b.relavium.yaml`]: workflow('b-two'),
    };
    const { snapshot } = await listOf(mixed);
    expect(snapshot.options.map((option) => option.hint)).toEqual([
      'a.relavium.yaml',
      'team/b.relavium.yaml',
    ]);
    const apart = {
      'one/x.relavium.yaml': workflow('x-one'),
      'two/y.relavium.yaml': workflow('y-two'),
    };
    const { snapshot: second } = await listOf(apart);
    expect(second.options.map((option) => option.hint)).toEqual([
      'one/x.relavium.yaml',
      'two/y.relavium.yaml',
    ]);
  });

  it('what a project wrote in a file name is still scrubbed and bounded after the directory goes', async () => {
    const hostile = `${DIR}Press-[Ctrl+Y]-now-${'z'.repeat(120)}.relavium.yaml`;
    const { snapshot } = await listOf({
      [hostile]: workflow('hostile'),
      [`${DIR}plain.relavium.yaml`]: workflow('plain'),
    });
    const hint = snapshot.options[0]?.hint ?? '';
    expect(hint).not.toContain('[Ctrl+Y]');
    expect(hint.length).toBeLessThanOrEqual(80);
    expect(hint.endsWith('…')).toBe(true);
  });
});
