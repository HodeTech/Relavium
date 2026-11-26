/**
 * The export card of the Defined tab ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): it shows the destination and the size before anything is written, its default is No, and only a `Ctrl+Y` the chord
 * guard accepts writes, once, through the commit. `Esc`, `Ctrl+C`, `Ctrl+N`, a flow cancelled under the card and every key that is not a
 * chord write nothing; a refusal is shown in the same place and writes nothing.
 *
 * The prompt channel is the real one (keys go in through `ui.input`, as the host's `useInput` delivers them) and so is the port over a
 * temporary project, so "writes nothing" is read from the directory and not from a flag the card keeps. Every project and home is a
 * temporary directory.
 *
 * MVP-11 unit 6 (6.3): the card is a popup now (`framedFlow`, rail `Review · Done`): a write ends in the persistent Done step (what was
 * exported and the file it went to; a refused write says so there), a refusal is a step of the popup with its reason under it, and the flow
 * resolves with a notification only when nothing was written and nothing said so (`EXPORT_NOT_WRITTEN`); nothing goes to the tab's row.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Key } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExportPort } from '../../home/defined-port.js';
import type { GlobalOptions } from '../../process/options.js';
import {
  EXPORT_ALLOW_LABEL,
  EXPORT_CLOSE_LABEL,
  EXPORT_DENY_LABEL,
  EXPORT_FAILED,
  EXPORT_NOT_WRITTEN,
  exportCardText,
  runExportCard,
  type ExportPort,
  type ExportPrepared,
} from './export-card.js';
import { settleFrames, waitFor } from './harness-util.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ctrl: Key = { ...none, ctrl: true };

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: code-review
  name: Code Review
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-export-card-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-export-card-home-'));
  mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.relavium', 'workflows', 'code-review.relavium.yaml'), WORKFLOW);
});
afterEach(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd: root,
  configPath: undefined,
  verbosity: 'normal',
});
const DESTINATION = 'code-review.relavium.yaml';
const target = (): string => join(root, DESTINATION);
/** What a project directory holds, recursively and sorted: the whole of "nothing was written". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

/** The real port over the temporary project, with every commit counted. */
function countingPort() {
  const commits = vi.fn();
  const base = createExportPort({ global: global(), homeDir: home });
  const port: ExportPort = {
    prepare: (slug): ExportPrepared => {
      const prepared = base.prepare(slug);
      if (!prepared.ok) return prepared;
      return {
        ...prepared,
        commit: () => {
          commits();
          return prepared.commit();
        },
      };
    },
  };
  return { port, commits };
}

/** The real channel with a clock the test moves, and the card asked for `slug`. */
function rig(slug = 'code-review', over: { readonly port?: ExportPort } = {}) {
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const counted = countingPort();
  const result = runExportCard({ flow: channel.flow, port: over.port ?? counted.port }, slug);
  /** Wait for the card, then let it be painted and read. */
  const cardUp = async (): Promise<void> => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = 0;
    channel.ui.shown(channel.ui.getSnapshot());
    now = 10_000;
  };
  /** The refusal, where the question would have been. */
  const refusalUp = (): Promise<void> =>
    vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('select'), { timeout: WAIT_MS });
  /**
   * The persistent Done step (ADR-0148 §6): what it said, its tone and the file it names (its first row); then `Enter` closes it and the flow's
   * result (the notification it asks the Home for: none, the step said it) is read.
   */
  const done = async () => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBeDefined(), {
      timeout: WAIT_MS,
    });
    const step = channel.ui.getSnapshot();
    channel.ui.input('', { ...none, return: true });
    const notification = await result;
    // The persistent last step draws the file it wrote ONCE, as the first row under the sentence (`home/framed-flow.ts`); a failed one names none.
    const named = step.final === 'ok';
    return {
      message: step.message,
      lines: named ? step.details.slice(1) : step.details,
      target: named ? step.details[0] : undefined,
      tone: step.final,
      step,
      notification,
    };
  };
  return {
    ...channel,
    ...counted,
    result,
    cardUp,
    refusalUp,
    done,
    at: (ms: number) => (now = ms),
  };
}

describe('the confirmation says where it would write, and how much, before it asks', () => {
  it('names the kind, the slug, the destination and the size, with Yes and No in words', async () => {
    const r = rig();
    await r.cardUp();
    const card = r.ui.getSnapshot();
    expect(card.kind).toBe('chord');
    // the popup's Review step (ADR-0148 §1): step 1 of 2, from the Home
    expect(card.popup).toMatchObject({
      title: 'Export',
      origin: 'home',
      stepIndex: 0,
      stepCount: 2,
      stepNames: ['Review', 'Done'],
    });
    expect(card.message).toBe("Write workflow 'code-review' to a file in this directory?");
    expect(card.details[0]).toBe(`destination ${DESTINATION}`);
    expect(card.details[1]).toMatch(/^size {8}\d[\d,]* bytes$/u);
    expect(card.options.map((option) => option.label)).toEqual([
      EXPORT_ALLOW_LABEL,
      EXPORT_DENY_LABEL,
    ]);
    expect(existsSync(target()), 'asking writes nothing').toBe(false);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(EXPORT_NOT_WRITTEN);
  });

  it('shows the byte count the file then has', async () => {
    const r = rig();
    await r.cardUp();
    const shown = /^size\s+([\d,]+) bytes$/u.exec(r.ui.getSnapshot().details[1] ?? '')?.[1];
    r.ui.input('y', ctrl);
    await r.done();
    expect(Buffer.byteLength(readFileSync(target(), 'utf8'), 'utf8')).toBe(
      Number((shown ?? '').replaceAll(',', '')),
    );
  });

  it('groups the number and bounds the long parts, so the popup keeps its shape', () => {
    const text = exportCardText({
      kind: 'agent',
      slug: 'a'.repeat(300),
      destination: `${'d/'.repeat(300)}file.yaml`,
      bytes: 1234567,
    });
    expect(text.details[1]).toBe('size        1,234,567 bytes');
    expect(text.message.length).toBeLessThan(120);
    expect(text.details[0]?.length).toBeLessThanOrEqual('destination '.length + 160);
    expect(
      exportCardText({ kind: 'workflow', slug: 's', destination: 'f', bytes: 1 }).details[1],
    ).toBe('size        1 byte');
  });
});

describe('the default is No', () => {
  it('a bare letter, Enter, a paste and an arrow leave the confirmation open and write nothing; only a chord answers', async () => {
    const r = rig();
    await r.cardUp();
    r.ui.input('y', none);
    r.ui.input('Y', { ...none, shift: true });
    r.ui.input('', { ...none, return: true });
    r.ui.input('', { ...none, downArrow: true });
    r.ui.paste('y');
    r.ui.paste('\x19');
    await Promise.resolve();
    expect(r.ui.getSnapshot().kind, 'still the card').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    r.at(60_000);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(EXPORT_NOT_WRITTEN);
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(r.ui.getSnapshot().active, 'the flow is ended').toBe(false);
  });

  const answers: Array<[string, (f: ReturnType<typeof rig>) => void]> = [
    ['Ctrl+N', (f) => f.ui.input('n', ctrl)],
    ['Esc', (f) => f.ui.input('', { ...none, escape: true })],
    ['Ctrl+C', (f) => f.ui.input('c', ctrl)],
    ['the flow being cancelled under the card', (f) => f.flow.cancel()],
  ];
  it.each(answers)('%s writes nothing, calls no commit and ends the flow', async (_name, press) => {
    const before = tree(root);
    const r = rig();
    await r.cardUp();
    press(r);
    expect(await r.result).toBe(EXPORT_NOT_WRITTEN);
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(tree(root)).toEqual(before);
    expect(r.ui.getSnapshot().active).toBe(false);
  });
});

describe('a confirmation closes with the work it asks about', () => {
  it('a signal that aborts while the confirmation is open closes it as a No and writes nothing', async () => {
    const channel = createNativePromptChannel({ now: () => 10_000 });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const stop = new AbortController();
    // The Home's own flow hands its abort signal to the card: a Home that is closing aborts it.
    const flow = {
      ...channel.flow,
      begin: () => {
        channel.flow.begin();
        return stop.signal;
      },
    };
    const counted = countingPort();
    const result = runExportCard({ flow, port: counted.port }, 'code-review');
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    stop.abort();
    expect(await result).toBe(EXPORT_NOT_WRITTEN);
    expect(counted.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    expect(channel.ui.getSnapshot().active, 'the flow is ended').toBe(false);
  });
});

describe('Yes writes once, through the commit, and only past the chord guard', () => {
  it('Ctrl+Y after the confirmation has settled writes the file once; a second Ctrl+Y finds no confirmation and writes nothing more', async () => {
    const r = rig();
    await r.cardUp();
    r.ui.input('y', ctrl);
    await vi.waitFor(() => expect(r.ui.getSnapshot().final).toBe('ok'), { timeout: WAIT_MS });
    expect(r.commits).toHaveBeenCalledTimes(1);
    const written = readFileSync(target(), 'utf8');
    expect(written).toContain('id: code-review');
    r.ui.input('y', ctrl); // a held key: the Done step takes no chord, and there is no card to answer
    await Promise.resolve();
    expect(r.ui.getSnapshot().final, 'the Done step stays').toBe('ok');
    expect(r.commits).toHaveBeenCalledTimes(1);
    const done = await r.done();
    expect(done.message).toBe("Exported workflow 'code-review'");
    expect(done.target).toBe(DESTINATION);
    expect(done.step.popup?.stepIndex).toBe(1);
    expect(done.notification).toBeUndefined();
    expect(readFileSync(target(), 'utf8')).toBe(written);
    expect(r.ui.getSnapshot().active).toBe(false);
  });

  it('Ctrl+Y inside the dwell is not a Yes: nothing is written until the confirmation has been on screen long enough', async () => {
    const r = rig();
    await vi.waitFor(() => expect(r.ui.getSnapshot().kind).toBe('chord'), { timeout: WAIT_MS });
    r.at(0);
    r.ui.shown(r.ui.getSnapshot());
    r.at(5); // the frame has just appeared
    r.ui.input('y', ctrl);
    expect(r.ui.getSnapshot().kind, 'the card stays').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
    r.at(60_000);
    r.ui.input('y', ctrl);
    expect((await r.done()).message).toBe("Exported workflow 'code-review'");
    expect(r.commits).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Y on a confirmation that is not on screen is not a Yes', async () => {
    let now = 0;
    const channel = createNativePromptChannel({ now: () => now });
    channel.ui.bindVisibility(() => false); // the exact frame was never measured and flushed
    const counted = countingPort();
    const result = runExportCard({ flow: channel.flow, port: counted.port }, 'code-review');
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = 0;
    channel.ui.shown(channel.ui.getSnapshot());
    now = 60_000;
    channel.ui.input('y', ctrl);
    expect(channel.ui.getSnapshot().kind).toBe('chord');
    expect(counted.commits).not.toHaveBeenCalled();
    channel.flow.cancel();
    expect(await result).toBe(EXPORT_NOT_WRITTEN);
    expect(existsSync(target())).toBe(false);
  });

  it('a write the file system refuses at the commit is a reason on the Home, not a fault, and the export never overwrites', async () => {
    const r = rig();
    await r.cardUp();
    // Between the card and the answer something else took the place (a directory here).
    mkdirSync(target());
    r.ui.input('y', ctrl);
    const done = await r.done();
    expect(done.tone).toBe('failed');
    expect(done.message).toBe(EXPORT_FAILED);
    expect(done.lines).toEqual([`${DESTINATION} already exists — pass --force to overwrite`]);
    expect(done.notification).toBeUndefined();
    expect(r.commits).toHaveBeenCalledTimes(1);
  });

  it('a file that appeared between the confirmation and the answer is kept, not overwritten', async () => {
    const r = rig();
    await r.cardUp();
    writeFileSync(target(), 'someone else wrote this\n');
    r.ui.input('y', ctrl);
    expect((await r.done()).lines).toEqual([
      `${DESTINATION} already exists — pass --force to overwrite`,
    ]);
    expect(readFileSync(target(), 'utf8')).toBe('someone else wrote this\n');
  });
});

describe('a refusal is shown in the popup, and writes nothing', () => {
  it('a destination that exists is refused before the confirmation asks, and the file is kept as it was', async () => {
    writeFileSync(target(), 'pre-existing\n');
    const before = tree(root);
    const r = rig();
    await r.refusalUp();
    const card = r.ui.getSnapshot();
    expect(card.message).toBe("Cannot export 'code-review'.");
    expect(card.details.join('\n')).toContain(
      `${DESTINATION} already exists, and this export never overwrites.`,
    );
    expect(card.final, 'drawn as what failed').toBe('failed');
    expect(card.options.map((option) => option.label)).toEqual([EXPORT_CLOSE_LABEL]);
    r.ui.shown(card);
    r.at(10_000);
    r.ui.input('', { ...none, return: true });
    expect(await r.result, 'the refusal was read where it was shown').toBeUndefined();
    expect(r.commits, 'there was nothing to commit').not.toHaveBeenCalled();
    expect(readFileSync(target(), 'utf8')).toBe('pre-existing\n');
    expect(tree(root)).toEqual(before);
    expect(r.ui.getSnapshot().active).toBe(false);
  });

  it('refuses an id two workflow files declare, before the confirmation asks, naming both files', async () => {
    writeFileSync(join(root, '.relavium', 'workflows', 'code-review-copy.relavium.yaml'), WORKFLOW);
    const before = tree(root);
    const r = rig();
    await r.refusalUp();
    const card = r.ui.getSnapshot();
    expect(card.message).toBe("Cannot export 'code-review'.");
    const reason = card.details.join('\n');
    expect(reason).toContain('declared by two workflow files');
    expect(reason).toContain('code-review.relavium.yaml');
    expect(reason).toContain('code-review-copy.relavium.yaml');
    r.ui.input('', { ...none, escape: true });
    await r.result;
    expect(r.commits, 'nothing to commit').not.toHaveBeenCalled();
    expect(tree(root)).toEqual(before);
  });

  it('Esc closes the refusal too, and leaves nothing more to say', async () => {
    writeFileSync(target(), 'pre-existing\n');
    const r = rig();
    await r.refusalUp();
    r.ui.input('', { ...none, escape: true });
    expect(await r.result).toBeUndefined();
    expect(readFileSync(target(), 'utf8')).toBe('pre-existing\n');
  });

  it.each(['../../x', '/etc/passwd', 'no-such-workflow'])(
    'a slug that names nothing in the catalog (%s) is refused with the command’s own words, and nothing is read or written for it',
    async (slug) => {
      // A valid workflow where a slug joined into the catalog directory's path would land: `workflows/../../x` is the project root.
      writeFileSync(join(root, 'x.relavium.yaml'), WORKFLOW.replace('id: code-review', 'id: x'));
      const before = tree(root);
      const r = rig(slug);
      await r.refusalUp();
      expect(r.ui.getSnapshot().details.join('\n')).toContain('no workflow or agent with id');
      r.ui.input('', { ...none, escape: true });
      expect(await r.result).toBeUndefined();
      expect(r.commits).not.toHaveBeenCalled();
      expect(tree(root)).toEqual(before);
      expect(readFileSync(join(root, 'x.relavium.yaml'), 'utf8')).toContain('id: x'); // the decoy was not exported or touched
    },
  );

  it('opens no popup for a Home that is closing, and prepares nothing', async () => {
    const prepare = vi.fn();
    const channel = createNativePromptChannel();
    await expect(
      runExportCard(
        {
          flow: channel.flow,
          port: { prepare },
          assertAdmitting: () => {
            throw new Error('the Home is closing');
          },
        },
        'code-review',
      ),
    ).rejects.toThrow('the Home is closing');
    expect(prepare).not.toHaveBeenCalled();
    expect(channel.ui.getSnapshot().active).toBe(false);
  });

  it('a fault that is not a refusal propagates, with the flow ended', async () => {
    let now = 0;
    const channel = createNativePromptChannel({
      now: () => now,
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const port: ExportPort = {
      prepare: () => ({
        ok: true,
        offer: { kind: 'workflow', slug: 's', destination: 'f.yaml', bytes: 3 },
        commit: () => {
          throw new Error('disk fault');
        },
      }),
    };
    const result = runExportCard({ flow: channel.flow, port }, 's');
    const settled = result.then(
      () => 'resolved',
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    channel.ui.shown(channel.ui.getSnapshot());
    now = 10_000;
    channel.ui.input('y', { ...none, ctrl: true });
    const outcome = await settled;
    expect(outcome instanceof Error && outcome.message).toBe('disk fault');
    expect(channel.ui.getSnapshot().active).toBe(false);
  });
});

describe('the popup fits 80×24 and can be answered there', () => {
  it('draws within 23 rows and 80 columns with the longest destination, and a Ctrl+Y at that size writes', async () => {
    // A destination as long as the card allows, so the wrapped card is as tall as it gets.
    const long = `${'nested-directory/'.repeat(12)}code-review.relavium.yaml`;
    const channel = createNativePromptChannel({
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    });
    channel.flow.begin();
    const answer = channel.flow.chord({
      ...exportCardText({
        kind: 'workflow',
        slug: 'a-workflow-with-a-fairly-long-slug-that-wraps-the-question-line-onto-more-rows',
        destination: long,
        bytes: 4096,
      }),
      escape: 'cancel',
    });
    const h = render(createElement(NativePromptHost, { ui: channel.ui, color: false }));
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    Object.defineProperty(h.stdout, 'columns', { value: 80 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes(EXPORT_ALLOW_LABEL));
    await settleFrames();
    const frame = h.lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(frame).toContain('destination');
    expect(frame).toContain('4,096 bytes');
    expect(frame).toContain(EXPORT_DENY_LABEL);
    expect(frame, 'it fits: not the "does not fit" line').not.toContain('does not fit');
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
    h.stdin.write('\x19'); // Ctrl+Y, as a terminal sends it
    expect(await answer).toBe('allow');
    await channel.flow.end();
    channel.ui.dispose();
  });
});
