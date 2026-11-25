/**
 * Requirements of the default-model save ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md) §1,
 * [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6) that `default-model-save.test.ts`
 * leaves open, found by the step-5 round-1 mutation sweep: a chat started with `--config` writes THAT file; only the card's own cancel is a
 * cancel (any other `CliError` is a failure); a chat that is closing starts no card at all; a cancel that raced a closing chat reports the
 * chat, not a cancel; and the card says what it is doing while it waits.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import { CliError } from '../process/errors.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { createChatDefaultModelWriter, saveDefaultModel } from './default-model-save.js';
import { createNativeFlushPort } from './native-flush-port.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CHOICE = { modelId: 'gpt-5', provider: 'openai', reasoningEffort: 'high' } as const;

/**
 * A stand-alone chat's writer over a real home, a real workspace, a config at `configFile` (the global one unless `custom` says it was given
 * with `--config`, in which case it is `custom.toml` beside the home) holding `existing` (no file when `undefined`), and a real native prompt
 * channel. `mounted` says whether a card's host is there to draw it.
 */
function writerFixture(options: {
  readonly existing: string | undefined;
  readonly custom?: boolean;
  readonly host?: 'mounted' | 'never';
}) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-default-model-gaps-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const globalPath = join(home, '.relavium', 'config.toml');
  const configPath = options.custom === true ? join(root, 'custom.toml') : globalPath;
  if (options.existing !== undefined) writeFileSync(configPath, options.existing);
  const runtime = createStartingModeRuntime(
    loadResolvedConfig({
      cwd,
      home,
      ...(options.custom === true ? { configPath } : {}),
    }),
    true,
  );
  const channel = createNativePromptChannel();
  let visible = false;
  channel.ui.bindVisibility(() => visible);
  const begin = vi.spyOn(channel.flow, 'begin');
  const port = createNativeFlushPort(channel.ui, {
    timer: (fire) => {
      const handle = setTimeout(fire, 60);
      return () => {
        clearTimeout(handle);
      };
    },
  });
  if (options.host !== 'never') {
    let mountedFor = false;
    channel.ui.subscribe(() => {
      const active = channel.ui.getSnapshot().active;
      if (!active) mountedFor = false;
      else if (!mountedFor) {
        mountedFor = true;
        port.ready(async (publish) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          await publish?.();
        });
      }
    });
  }
  let admitting = true;
  const write = createChatDefaultModelWriter({
    runtime,
    flow: channel.flow,
    ui: channel.ui,
    mounted: (signal) => port.mounted(signal),
    assertAdmitting: () => {
      if (!admitting) throw new CliError('invalid_invocation', 'The chat is closing.');
    },
  });
  return {
    root,
    globalPath,
    configPath,
    runtime,
    channel,
    begin,
    write,
    show: (): void => {
      visible = true;
    },
    close: (): void => {
      admitting = false;
    },
  };
}

describe('the writer targets the file the chat was started with', () => {
  it('a chat started with `--config` writes that file and never creates the global one', async () => {
    const f = writerFixture({ existing: undefined, custom: true });
    await f.write('gpt-5', 'openai', 'high');
    expect(existsSync(f.globalPath)).toBe(false);
    const written = readFileSync(f.configPath, 'utf8');
    expect(written).toMatch(/default_model = "gpt-5"/u);
    expect(written).toMatch(/default_provider = "openai"/u);
    expect(written).toMatch(/reasoning_effort = "high"/u);
  });
});

describe('what a refused save is called', () => {
  const refusedBy = async (cause: unknown) =>
    saveDefaultModel(
      {
        write: () => {
          throw cause;
        },
        readEffective: () => undefined,
        closing: () => false,
      },
      CHOICE,
    );

  it('a `CliError` that is not the card’s cancel is a failure, not a cancel', async () => {
    await expect(refusedBy(new CliError('cli_internal', 'boom'))).resolves.toEqual({
      kind: 'refused',
      reason: 'failed',
    });
  });
});

describe('a closing chat', () => {
  it('starts no card and writes nothing, even over an existing config', async () => {
    const original = '[preferences]\ntheme = "kept"\n';
    const f = writerFixture({ existing: original });
    f.close();
    await expect(f.write('gpt-5', 'openai')).rejects.toThrow('The chat is closing.');
    expect(f.begin).not.toHaveBeenCalled();
    expect(readFileSync(f.configPath, 'utf8')).toBe(original);
  });

  it('a cancel that raced the closing says the chat is closing, not that the person cancelled', async () => {
    const f = writerFixture({ existing: '[preferences]\ntheme = "kept"\n' });
    const pending = f.write('gpt-5', 'openai');
    const outcome = pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(f.begin).toHaveBeenCalledTimes(1));
    f.close();
    f.channel.flow.cancel();
    const error = await outcome;
    expect(error).toBeInstanceOf(CliError);
    expect(error instanceof CliError ? error.message : '').toBe('The chat is closing.');
  });
});

describe('the card of a rewrite', () => {
  it('says what it is doing while it waits for its host', async () => {
    const f = writerFixture({ existing: '[preferences]\ntheme = "kept"\n', host: 'never' });
    f.show();
    const pending = f.write('gpt-5', 'openai');
    const outcome = pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(f.begin).toHaveBeenCalledTimes(1));
    expect(f.channel.ui.getSnapshot()).toMatchObject({
      active: true,
      kind: 'busy',
      message: 'Saving default model…',
    });
    f.channel.flow.cancel();
    await outcome;
  });
});
