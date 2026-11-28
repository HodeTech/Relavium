import '../render/tui/force-color.js';
import type { SessionPage, SessionPageRow } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { NativePromptHost } from '../render/tui/native-prompt-host.js';
import { mountInk, type InkMount } from '../render/tui/surface-matrix/mount.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { displayWidth } from '../render/tui/viewport.js';
import { createSessionPickerSource } from './session-picker.js';

/**
 * The resume picker's "All directories" scope names each session's directory as the rest of the CLI does ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8): the project in words, a directory inside it from the project, one inside the home from `~`, and one outside both whole but cut at the FRONT
 * to the row, so the end that tells one directory from another stays. Observed before: four rows each ending in the same long absolute prefix, so the
 * scope could not tell its directories apart.
 */
const VARIANT: Variant = { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } };
const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;
const NOW = Date.parse('2026-11-25T12:00:00.000Z');

const LONG_OUTSIDE = `/private/tmp/claude-501/-Users-someone-Documents-Projects-Relavium/${'b09bdff9-7ea2-4ec5-9299-41e903d919f9/'.repeat(2)}outside-cmd`;
const DIRECTORIES = [
  ['the project itself', '/work/project', '. (project root)'],
  ['inside the project', '/work/project/packages/app', 'packages/app'],
  ['inside the home', '/home/me/other', '~/other'],
  ['outside both, too long for the row', LONG_OUTSIDE, 'outside-cmd'],
] as const;

const rows: readonly SessionPageRow[] = DIRECTORIES.map(([name, workingDir], index) => ({
  id: `sess-${String(index)}`,
  agentSlug: 'coder',
  title: `Session ${name}`,
  updatedAt: new Date(NOW - index * 60_000).toISOString(),
  workingDir,
}));
const page: SessionPage = { sessions: rows };

let mount: InkMount | undefined;
afterEach(() => {
  mount?.unmount();
  mount = undefined;
});

async function openAllDirectories(paths: typeof ROOTS | undefined): Promise<string[]> {
  const channel = createNativePromptChannel();
  mount = mountInk(<NativePromptHost ui={channel.ui} color />, VARIANT);
  channel.flow.begin();
  const load = createSessionPickerSource({
    store: { listSessionPage: () => page },
    cwd: ROOTS.cwd,
    ...(paths === undefined ? {} : { paths }),
    now: () => NOW,
    assertAdmitting: () => {},
    runRead: (operation) => operation(),
  });
  const answer = channel.flow.pick({ message: 'Resume a session', load });
  const shown = (words: string): boolean =>
    mount?.frame().some((line) => line.includes(words)) === true;
  await vi.waitFor(
    async () => {
      await mount?.settle();
      expect(shown('This directory')).toBe(true);
    },
    { timeout: 3000, interval: 20 },
  );
  mount.key('\t'); // This directory -> All directories
  await vi.waitFor(
    async () => {
      await mount?.settle();
      expect(shown('All directories'), mount?.frame().join('\n')).toBe(true);
      expect(shown('outside-cmd'), mount?.frame().join('\n')).toBe(true);
    },
    { timeout: 3000, interval: 20 },
  );
  const frame = mount.frame();
  mount.key('\x1b');
  await Promise.race([answer, mount.settle()]);
  return frame;
}

describe('the resume picker in All directories', () => {
  it('names each directory as a person does, in rows no wider than 80 columns, and tells four directories apart', async () => {
    const frame = await openAllDirectories(ROOTS);
    const text = frame.join('\n');
    expect(text, text).toContain('All directories');
    const hints = frame.map((line) => line.trim()).filter((line) => !line.includes('Session'));
    for (const [name, , shown] of DIRECTORIES) {
      expect(
        hints.some((line) => line === shown || line.endsWith(shown)),
        `${name}: ${shown}\n${text}`,
      ).toBe(true);
    }
    // The long one is cut at the front (an ellipsis) and still ends in the folder that tells it from the others.
    const long = hints.find((line) => line.endsWith('outside-cmd')) ?? '';
    expect(long.startsWith('…'), long).toBe(true);
    expect(text).not.toContain('/home/me');
    expect(text).not.toContain('/work/project');
    for (const line of frame) expect(displayWidth(line), line).toBeLessThanOrEqual(80);
  });

  it('draws the directory as it is stored when the host passes no roots, still bounded to the row', async () => {
    const frame = await openAllDirectories(undefined);
    const text = frame.join('\n');
    expect(text).toContain('/home/me/other');
    expect(text).toContain('/work/project/packages/app');
    for (const line of frame) expect(displayWidth(line), line).toBeLessThanOrEqual(80);
  });
});
