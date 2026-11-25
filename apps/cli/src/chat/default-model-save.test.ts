/**
 * Saving the default model of new chats from the `/models` popup ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md) §1,
 * [ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §6, [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): the one adapter both hosts' writers are reached through, and a stand-alone chat's writer, which it never had before.
 *
 * What it pins. The adapter never rejects and says what the write came to: saved, with its durability and whether the effective default is
 * now the model (a project override is never reported as applied), or refused by kind, a writer's fault reported to the owner first; nothing
 * is said while the host is closing. The writer takes the Home's path and consent: the global `[preferences]` (model, provider and tier in
 * one write) of the file the chat's config came from, the starting-mode observer on the read, no card for a file that does not exist yet,
 * and for an existing file the rewrite disclosure on this chat's native card, published only while that card is visibly on screen; a card
 * cancelled or a symbolic-link config writes nothing.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import { ConfigWriteRefusedError } from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { CliError } from '../process/errors.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { createChatDefaultModelWriter, saveDefaultModel } from './default-model-save.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CHOICE = { modelId: 'gpt-5', provider: 'openai', reasoningEffort: 'high' } as const;

describe('saveDefaultModel: what a write came to, never a rejection', () => {
  const base = { readEffective: () => 'gpt-5', closing: () => false };

  it('saved: the writer’s durability, and the effective default read again says whether it applies here', async () => {
    const write = vi.fn(() => Promise.resolve({ durability: 'unconfirmed' as const }));
    await expect(saveDefaultModel({ ...base, write }, CHOICE)).resolves.toEqual({
      kind: 'saved',
      durability: 'unconfirmed',
      effect: 'applies',
    });
    expect(write).toHaveBeenCalledExactlyOnceWith('gpt-5', 'openai', 'high');
    // A writer that returns nothing (a synchronous test writer) is a confirmed write.
    await expect(
      saveDefaultModel({ ...base, write: () => undefined }, CHOICE),
    ).resolves.toMatchObject({
      durability: 'confirmed',
    });
  });

  it('a project or workspace that names another model is said as overridden, never as applied', async () => {
    await expect(
      saveDefaultModel(
        { ...base, readEffective: () => 'claude-opus-4-5', write: () => undefined },
        CHOICE,
      ),
    ).resolves.toMatchObject({ kind: 'saved', effect: 'overridden' });
  });

  it('a configuration that cannot be read back (or names no model) is unknown: the write still happened', async () => {
    const reads = [
      () => {
        throw new Error('the config does not parse now');
      },
      () => undefined,
    ];
    for (const readEffective of reads)
      await expect(
        saveDefaultModel({ ...base, readEffective, write: () => undefined }, CHOICE),
      ).resolves.toMatchObject({ kind: 'saved', effect: 'unknown' });
  });

  it('refused by kind: a symbolic link, a cancelled card, any other failure; a writer’s fault is reported to the owner first', async () => {
    const failure = vi.fn();
    const refused = async (cause: unknown) =>
      saveDefaultModel(
        {
          ...base,
          failure,
          write: () => {
            throw cause;
          },
        },
        CHOICE,
      );
    await expect(refused(new ConfigWriteRefusedError())).resolves.toEqual({
      kind: 'refused',
      reason: 'symlink',
    });
    await expect(
      refused(new CliError('invalid_invocation', 'Default model change cancelled.')),
    ).resolves.toEqual({ kind: 'refused', reason: 'cancelled' });
    await expect(refused(new Error('disk full'))).resolves.toEqual({
      kind: 'refused',
      reason: 'failed',
    });
    expect(failure).toHaveBeenCalledTimes(3);
  });

  it('nothing is said while the host is closing, whatever the writer did', async () => {
    const closing = (): boolean => true;
    await expect(
      saveDefaultModel({ ...base, closing, write: () => undefined }, CHOICE),
    ).resolves.toEqual({ kind: 'refused', reason: 'closing' });
    const failure = vi.fn();
    await expect(
      saveDefaultModel(
        {
          ...base,
          closing,
          failure,
          write: () => {
            throw new Error('x');
          },
        },
        CHOICE,
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'closing' });
    expect(failure).not.toHaveBeenCalled();
  });
});

/** A stand-alone chat's writer over a real home, config and runtime, and a real native prompt channel whose visibility the test decides. */
function writerFixture(existing: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-default-model-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  if (existing !== undefined) writeFileSync(configPath, existing);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  const channel = createNativePromptChannel();
  let visible = false;
  channel.ui.bindVisibility(() => visible);
  const begin = vi.spyOn(channel.flow, 'begin');
  const notes: string[] = [];
  const note = channel.flow.note;
  vi.spyOn(channel.flow, 'note').mockImplementation((message, title) => {
    notes.push(message);
    note(message, title);
  });
  const flushes: number[] = [];
  // As the renderer's flush is: the frame is drawn on a later turn of the event loop (a flush that settled in a microtask would let a refused
  // publication retry without end, which no renderer does).
  const flush: NoticeFlush = async (publish) => {
    flushes.push(flushes.length);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await publish?.();
  };
  let admitting = true;
  const write = createChatDefaultModelWriter({
    runtime,
    flow: channel.flow,
    ui: channel.ui,
    flushVisible: () => flush,
    assertAdmitting: () => {
      if (!admitting) throw new CliError('invalid_invocation', 'The chat is closing.');
    },
  });
  return {
    root,
    configPath,
    runtime,
    channel,
    begin,
    notes,
    flushes,
    write,
    show: (): void => {
      visible = true;
    },
    close: (): void => {
      admitting = false;
    },
  };
}

describe('a stand-alone chat’s writer (the Home’s path and consent)', () => {
  it('a config that does not exist yet is written with no card, the model, its provider and its tier in one write', async () => {
    const f = writerFixture(undefined);
    await expect(f.write('gpt-5', 'openai', 'high')).resolves.toMatchObject({
      durability: expect.any(String) as unknown,
    });
    expect(f.begin).not.toHaveBeenCalled();
    const written = readFileSync(f.configPath, 'utf8');
    expect(written).toMatch(/default_model = "gpt-5"/u);
    expect(written).toMatch(/default_provider = "openai"/u);
    expect(written).toMatch(/reasoning_effort = "high"/u);
  });

  it('an existing config is rewritten only behind this chat’s card, which says it loses its comments, and only once that card is visible', async () => {
    const original = '# my comment\n[preferences]\ntheme = "kept"\n';
    const f = writerFixture(original);
    const pending = f.write('gpt-5', 'openai');
    // The card is up and says what the rewrite does; nothing is published while it is not on screen.
    await vi.waitFor(() => expect(f.notes.length).toBeGreaterThan(0));
    expect(f.begin).toHaveBeenCalledTimes(1);
    // Every frame the publication waits on says it (a refused publication notes it again on the next frame).
    expect(new Set(f.notes)).toEqual(
      new Set([
        'Saving preferences rewrites the global config and removes its comments and ordering.',
      ]),
    );
    await vi.waitFor(() => expect(f.flushes.length).toBeGreaterThan(1));
    expect(readFileSync(f.configPath, 'utf8')).toBe(original);
    f.show();
    await pending;
    const written = readFileSync(f.configPath, 'utf8');
    expect(written).toMatch(/default_model = "gpt-5"/u);
    expect(written).toMatch(/theme = "kept"/u);
    expect(written).not.toContain('# my comment');
    // The card is ended with the write.
    expect(f.channel.ui.getSnapshot().active).toBe(false);
  });

  it('a card the person cancels writes nothing and is a cancel', async () => {
    const original = '[preferences]\ntheme = "kept"\n';
    const f = writerFixture(original);
    const pending = f.write('gpt-5', 'openai');
    await vi.waitFor(() => expect(f.notes.length).toBeGreaterThan(0));
    f.channel.flow.cancel();
    const error = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error instanceof CliError ? error.code : undefined).toBe('invalid_invocation');
    expect(readFileSync(f.configPath, 'utf8')).toBe(original);
    await expect(
      saveDefaultModel(
        {
          write: () => Promise.reject(error instanceof Error ? error : new Error('not an error')),
          readEffective: () => undefined,
          closing: () => false,
        },
        CHOICE,
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'cancelled' });
  });

  it('a symbolic-link config is refused and left as it is', async () => {
    const f = writerFixture(undefined);
    const target = join(f.root, 'elsewhere.toml');
    writeFileSync(target, '[preferences]\n');
    symlinkSync(target, f.configPath);
    await expect(f.write('gpt-5', 'openai')).rejects.toBeInstanceOf(ConfigWriteRefusedError);
    expect(lstatSync(f.configPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('[preferences]\n');
  });

  it('a chat that is closing writes nothing', async () => {
    const f = writerFixture(undefined);
    f.close();
    await expect(f.write('gpt-5', 'openai')).rejects.toBeInstanceOf(CliError);
    expect(() => readFileSync(f.configPath, 'utf8')).toThrow();
  });

  it('the read of the file is observed for the starting mode: a file that is not in auto revokes a startup auto', async () => {
    const f = writerFixture('[preferences]\ndefault_mode = "ask"\n');
    const before = f.runtime.authority.revocationRevision;
    f.show();
    await f.write('gpt-5', 'openai');
    expect(f.runtime.authority.revocationRevision).toBeGreaterThan(before);
  });
});
