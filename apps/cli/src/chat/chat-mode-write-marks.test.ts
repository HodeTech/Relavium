import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolApprovalRequest } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { createCommandGrantStore, type CommandGrantStore } from '../permissions/command-grants.js';
import {
  ApprovalCache,
  buildTurnPolicy,
  type ApprovalAnswer,
  type ApprovalPrompt,
} from './chat-mode.js';

/**
 * ADR-0138 through the REAL store and the REAL hook together (the unit tests of each use a fake of the other): a grant is made, a file
 * write is approved, a new chat (a new cache) asks about the grant until it is renewed. A fake store cannot show that the two halves
 * agree on what "fresh" means.
 */
class FakeKeychain implements KeychainStore {
  readonly entries = new Map<string, string>();
  get(account: string): string | null {
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string): void {
    if (secret === '') throw new KeychainUnavailableError('denied');
    this.entries.set(account, secret);
  }
  delete(account: string): boolean {
    return this.entries.delete(account);
  }
}

let home: string;
let project: string;
let keychain: FakeKeychain;
let clock = 0;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-hook-marks-home-'));
  project = mkdtempSync(join(tmpdir(), 'relavium-hook-marks-project-'));
  keychain = new FakeKeychain();
  clock = Date.parse('2026-11-21T10:00:00.000Z');
  counter = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const store = (): CommandGrantStore =>
  createCommandGrantStore({
    homeDir: home,
    projectRoot: project,
    keychain,
    now: () => new Date(clock),
    newId: () => `grant-${String(++counter)}`,
    findProgram: (name) => Promise.resolve(name === 'npm' ? '/usr/bin/npm' : undefined),
  });

const TEST = ['npm', 'test'] as const;
const command = (argv: readonly string[]): ToolApprovalRequest => ({
  toolId: 'run_command',
  action: 'process',
  preview: { command: argv.join(' ') },
  unredactedPreview: { command: argv.join(' ') },
  argv,
  commandAdmitted: false,
});
const WRITE: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'package.json' },
  unredactedPreview: { path: 'package.json' },
};

/** One chat: a fresh approval cache over the shared store, in the given mode, whose prompt answers `answer`. */
function chat(grants: CommandGrantStore, mode: 'auto' | 'accept-edits', answer: ApprovalAnswer) {
  const prompt = vi.fn<ApprovalPrompt>(() => Promise.resolve(answer));
  const policy = buildTurnPolicy(mode, {
    commandPaths: undefined,
    governed: new Set(['run_command', 'fs_write']),
    prompt,
    cache: new ApprovalCache(),
    commandSessionGrants: true,
    commandCwd: project,
    commandGrants: grants,
  });
  if (policy.confirm === undefined) throw new Error('a policy always has a confirm hook');
  const { confirm } = policy;
  return { confirm, prompt };
}

describe('a grant, a file write and a new chat, through the real store and the real hook (ADR-0138)', () => {
  it('runs unasked while fresh; asks in a NEW chat after a write was approved; Remember renews it for the chat after that', async () => {
    const remembered: ApprovalAnswer = { outcome: 'approve', scope: 'remember' };
    // Chat 1 (auto): the person remembers the command on its card.
    const first = chat(store(), 'auto', remembered);
    await first.confirm(command(TEST), undefined, undefined);
    expect(first.prompt).toHaveBeenCalledTimes(1);
    // Chat 2 (auto): the grant is fresh, so it runs without a card.
    clock += 1000;
    const second = chat(store(), 'auto', { outcome: 'approve', scope: 'once' });
    expect(await second.confirm(command(TEST), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(second.prompt).not.toHaveBeenCalled();
    // Chat 3 (accept-edits): a model edit of package.json is applied with no card, and recorded for the project.
    clock += 1000;
    const editing = chat(store(), 'accept-edits', { outcome: 'approve', scope: 'once' });
    await editing.confirm(WRITE, undefined, undefined);
    expect(editing.prompt).not.toHaveBeenCalled();
    // Chat 4 (auto, a NEW cache, as after /clear or a restart): the grant predates the write, so it asks, and says why.
    clock += 1000;
    const fourth = chat(store(), 'auto', { outcome: 'approve', scope: 'once' });
    await fourth.confirm(command(TEST), undefined, undefined);
    expect(fourth.prompt).toHaveBeenCalledTimes(1);
    expect(fourth.prompt.mock.calls[0]?.[4]).toMatchObject({
      standing: 'remembered',
      grantOutdated: true,
      offers: { remember: true },
    });
    // Chat 5 renews it with Remember...
    clock += 1000;
    const fifth = chat(store(), 'auto', remembered);
    await fifth.confirm(command(TEST), undefined, undefined);
    expect(fifth.prompt).toHaveBeenCalledTimes(1);
    // ...and chat 6 runs it unasked again.
    clock += 1000;
    const sixth = chat(store(), 'auto', { outcome: 'approve', scope: 'once' });
    expect(await sixth.confirm(command(TEST), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(sixth.prompt).not.toHaveBeenCalled();
  });

  it('a Session answer ends the asking for that chat only: the next chat asks again until the grant is renewed', async () => {
    const grants = store();
    await chat(grants, 'auto', { outcome: 'approve', scope: 'remember' }).confirm(
      command(TEST),
      undefined,
      undefined,
    );
    clock += 1000;
    await chat(store(), 'accept-edits', { outcome: 'approve', scope: 'once' }).confirm(
      WRITE,
      undefined,
      undefined,
    );
    clock += 1000;
    const session = chat(store(), 'auto', { outcome: 'approve', scope: 'always' });
    const decision = await session.confirm(command(TEST), undefined, undefined);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    await session.confirm(command(TEST), undefined, undefined);
    expect(session.prompt).toHaveBeenCalledTimes(1); // the second call in this chat needed no card
    const next = chat(store(), 'auto', { outcome: 'approve', scope: 'once' });
    await next.confirm(command(TEST), undefined, undefined);
    expect(next.prompt).toHaveBeenCalledTimes(1); // the next chat asks again
  });
});
