import '../render/tui/force-color.js';

import { dirname, basename } from 'node:path';

import type { ToolApprovalLiveContext, ToolApprovalRequest } from '@relavium/core';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatApp } from '../render/tui/chat-ink.js';
import { mountInk } from '../render/tui/surface-matrix/mount.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { DisplayPathRoots } from '../render/notation.js';
import { realModeControl, type RealModeControl } from './chat-mode-control.test-support.js';

/**
 * The command card names the directory the command runs in as the rest of the CLI names a path ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8: project-relative or from `~`, never absolute unless it is outside both), through the production mode control the stand-alone chat and the
 * Home both receive, the real store and the real chat view. The card is a consent path: it keeps its height and its width, a directory outside
 * both roots is drawn whole, and a card built without the roots draws the host's path as it always did.
 */
const REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const LIVE: ToolApprovalLiveContext = {
  callId: 'call',
  preview: {
    kind: 'operation',
    target: 'npm test',
    fields: [
      { name: '', value: 'npm' },
      { name: '', value: 'test' },
    ],
  },
};
const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

const made: RealModeControl[] = [];
afterEach(async () => {
  for (const control of made.splice(0)) {
    control.store.sealToolPreviews(); // a card still open is cancelled, not answered
    await control.dispose();
  }
});

/** What the real card of a command run in a fresh workspace says, given the roots the host passed: the whole frame, and the `Runs in:` row. */
async function cardWith(roots: ((workspace: string) => DisplayPathRoots) | undefined): Promise<{
  readonly frame: readonly string[];
  readonly row: string;
  readonly workspace: string;
}> {
  const m = await realModeControl(roots === undefined ? {} : { commandPaths: roots });
  made.push(m);
  void m
    .policy()
    ?.confirm?.(REQUEST, undefined, LIVE)
    ?.catch(() => undefined);
  const mount = mountInk(
    <ChatApp
      store={m.store}
      onSubmit={() => Promise.resolve()}
      shouldStop={() => false}
      onExit={() => {}}
      onError={(cause) => {
        throw cause;
      }}
      onModeChange={() => {}}
      alternateScreen
    />,
    VARIANT,
  );
  try {
    await mount.until(() => mount.frame().some((line) => line.includes('Runs in:')));
    await mount.settle();
    const frame = mount.frame();
    const row = frame.find((line) => line.includes('Runs in:')) ?? '';
    return { frame, row, workspace: m.workspace };
  } finally {
    mount.unmount();
  }
}

const home = '/nonexistent-home';

describe('the command card of the production mode control, with the roots the chat handler passes', () => {
  it('names the project’s own directory in words', async () => {
    const card = await cardWith((workspace) => ({ cwd: workspace, home }));
    expect(card.row).toContain('Runs in: . (project root)');
    expect(card.row).not.toContain(card.workspace);
  });

  it('names a directory inside the project from the project', async () => {
    const card = await cardWith((workspace) => ({ cwd: dirname(workspace), home }));
    expect(card.row).toContain(`Runs in: ${basename(card.workspace)}`);
    expect(card.row).not.toContain(dirname(card.workspace));
  });

  it('names a directory inside the home, and outside the project, from ~', async () => {
    const card = await cardWith((workspace) => ({
      cwd: '/nonexistent-project',
      home: dirname(workspace),
    }));
    expect(card.row).toContain(`Runs in: ~/${basename(card.workspace)}`);
  });

  it('keeps a directory outside both roots whole, absolute, with its end', async () => {
    const card = await cardWith(() => ({ cwd: '/nonexistent-project', home }));
    expect(card.row).toContain('Runs in: ');
    expect(card.row.endsWith(card.workspace.slice(-24)), card.row).toBe(true);
    expect(card.row).not.toContain('~');
    expect(card.row).not.toContain('(project root)');
  });

  it('draws the host’s own path when the handler passes no roots, exactly as before', async () => {
    const card = await cardWith(undefined);
    expect(card.row.endsWith(card.workspace.slice(-24)), card.row).toBe(true);
    expect(card.row).not.toContain('(project root)');
  });

  it('keeps the card’s height and width: never taller, never wider than the card without the roots', async () => {
    const without = await cardWith(undefined);
    for (const roots of [
      (workspace: string): DisplayPathRoots => ({ cwd: workspace, home }),
      (workspace: string): DisplayPathRoots => ({ cwd: dirname(workspace), home }),
      (workspace: string): DisplayPathRoots => ({
        cwd: '/nonexistent-project',
        home: dirname(workspace),
      }),
      (): DisplayPathRoots => ({ cwd: '/nonexistent-project', home }),
    ]) {
      const card = await cardWith(roots);
      expect(card.frame.length, card.frame.join('\n')).toBeLessThanOrEqual(without.frame.length);
      for (const line of card.frame) expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });
});
