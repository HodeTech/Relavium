import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderKeyValidation } from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { CliIo } from '../process/io.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { KeychainUnavailableError } from '../secrets/keychain.js';
import { keyStepNote, leftoverSetupNote, setupSkippedNotice } from './setup-notes.js';
import { runNativeSetup, type OnboardingDefaultResult } from './wizard.js';

/**
 * What the native first run SAYS (MVP-11 Step 2.4, ADR-0146 §6), read from the native prompt channel the Home and a stand-alone chat both
 * host it in: the first-run sentence belongs to a genuine first run only; a skip leaves one line and not an instruction; the keychain-down
 * note names the environment variable as a variable name and no shell command; a provider is named by its display name.
 */

const io: CliIo = {
  env: {},
  stdoutIsTty: true,
  stdinIsTty: true,
  stdin: Readable.from([]),
  writeOut: () => {},
  writeErr: () => {},
  writeOutAcknowledged: async () => {},
  writeErrAcknowledged: async () => {},
};
const key = {
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
const next = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) {
    if (predicate()) return;
    await next();
  }
  throw new Error('the card never reached the expected state');
}

interface Run {
  /** Every distinct note the card showed, in order. */
  readonly notes: string[];
  /** What the card's note was when the wizard returned (what a host would keep as the notice). */
  readonly finalNote: string;
  readonly writeDefaultModel: ReturnType<typeof vi.fn>;
}

/** Drive one native wizard run: type a key, answer what the card then asks (by value), and report what was said. */
async function run(options: {
  readonly surface?: 'home' | 'standalone-chat';
  readonly selectStarterDefault?: boolean;
  readonly initialProvider?: 'anthropic' | 'openai';
  readonly validation: ProviderKeyValidation;
  readonly answers: readonly string[];
  readonly keychainSet?: () => void;
  readonly defaultResult?: OnboardingDefaultResult | Error;
  /** The wizard runs under a work owner, as the Home runs it: the check is then announced, and that announcement is what is under test. */
  readonly owned?: boolean;
}): Promise<Run> {
  const client = createClient(':memory:');
  runMigrations(client.db);
  try {
    const channel = createNativePromptChannel();
    const signal = channel.flow.begin();
    const notes: string[] = [];
    channel.ui.subscribe(() => {
      const note = channel.ui.getSnapshot().note;
      if (note !== '' && notes.at(-1) !== note) notes.push(note);
    });
    const writeDefaultModel = vi.fn(() =>
      options.defaultResult instanceof Error
        ? Promise.reject(options.defaultResult)
        : Promise.resolve(options.defaultResult ?? { kind: 'saved', durability: 'confirmed' }),
    );
    const workOwner =
      options.owned === true
        ? new InvocationWorkOwner(
            invocationFixture().invocation,
            { kind: 'command' },
            { cancel: () => {}, cleanup: () => Promise.resolve() },
          )
        : undefined;
    const running = runNativeSetup(
      {
        ...(workOwner === undefined ? {} : { workOwner }),
        ...(options.initialProvider === undefined
          ? {}
          : { initialProvider: options.initialProvider }),
        io,
        store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
        keychain: {
          get: () => null,
          set: options.keychainSet ?? (() => {}),
          delete: () => false,
        },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve(options.validation),
        writeDefaultModel,
      },
      {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'Official endpoint',
        ...(options.selectStarterDefault === undefined
          ? {}
          : { selectStarterDefault: options.selectStarterDefault }),
        ...(options.surface === undefined ? {} : { surface: options.surface }),
      },
    );
    // The provider list (when no provider was given) takes its first option; the key is pasted; each later card takes the answer in turn.
    if (options.initialProvider === undefined) {
      await until(() => channel.ui.getSnapshot().kind === 'select');
      channel.ui.input('\r', { ...key, return: true });
    }
    await until(() => channel.ui.getSnapshot().kind === 'password');
    channel.ui.paste('synthetic-first-run-key-4829');
    channel.ui.input('\r', { ...key, return: true });
    for (const answer of options.answers) {
      await until(() => channel.ui.getSnapshot().kind === 'select');
      const at = channel.ui.getSnapshot().options.findIndex((option) => option.value === answer);
      if (at < 0) throw new Error(`the card offers no "${answer}"`);
      for (let step = 0; step < at; step += 1) channel.ui.input('', { ...key, downArrow: true });
      channel.ui.input('\r', { ...key, return: true });
    }
    await running;
    const finalNote = channel.ui.getSnapshot().note;
    await channel.flow.end();
    return { notes, finalNote, writeDefaultModel };
  } finally {
    client.sqlite.close();
  }
}

const NETWORK: ProviderKeyValidation = { ok: false, reason: 'network', detail: 'timeout' };
const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const FIRST_RUN_SENTENCE = 'Connect a model provider to start chatting.';

describe('the first-run sentence belongs to a genuine first run', () => {
  it('is shown on the provider list of a first run', async () => {
    const result = await run({ validation: OK, answers: [] });
    expect(result.notes.some((note) => note.includes(FIRST_RUN_SENTENCE))).toBe(true);
  });

  it('is NOT shown when a key is added or replaced while another source already works (key maintenance)', async () => {
    const result = await run({ selectStarterDefault: false, validation: OK, answers: [] });
    expect(result.notes.join('\n')).not.toContain(FIRST_RUN_SENTENCE);
    expect(result.notes.join('\n')).not.toContain('First-run setup');
  });
});

describe('a skip leaves one line, and an instruction is never the notice', () => {
  it.each([
    ['home', 'Setup skipped · /providers connects a provider anytime'],
    ['standalone-chat', 'Setup skipped · restart this chat to open provider setup any time'],
  ] as const)(
    'the Skip setup row after a failed check, on %s, ends on the skip line',
    async (surface, line) => {
      const result = await run({
        surface,
        initialProvider: 'anthropic',
        validation: NETWORK,
        answers: ['skip'],
      });
      expect(result.finalNote).toBe(line);
      expect(setupSkippedNotice(surface)).toBe(line);
      expect(leftoverSetupNote(result.finalNote), 'a skip line is a note worth keeping').toBe(line);
    },
  );

  it('leftoverSetupNote drops the two notes that only say what a step is, and keeps one that reports something', () => {
    expect(leftoverSetupNote(`First-run setup: ${FIRST_RUN_SENTENCE} Your key is stored`)).toBe(
      undefined,
    );
    expect(leftoverSetupNote('Provider destination: Official endpoint')).toBeUndefined();
    // The key step's note (MVP-11 unit 6) says where the key goes: an instruction, never kept as a notice.
    expect(leftoverSetupNote(keyStepNote('api.anthropic.com'))).toBeUndefined();
    expect(leftoverSetupNote('')).toBeUndefined();
    expect(leftoverSetupNote(undefined)).toBeUndefined();
    expect(leftoverSetupNote('Could not save the keychain reminder.')).toBe(
      'Could not save the keychain reminder.',
    );
    expect(leftoverSetupNote('Setup skipped · /providers connects a provider anytime')).toBe(
      'Setup skipped · /providers connects a provider anytime',
    );
  });
});

describe('a locked keychain after the key was typed', () => {
  it('names the environment variable as a variable name, once, and tells nobody to run a shell command', async () => {
    const result = await run({
      initialProvider: 'openai',
      validation: OK,
      answers: [],
      keychainSet: () => {
        throw new KeychainUnavailableError('locked');
      },
    });
    const note = result.notes.find((candidate) => candidate.includes('Keychain unavailable')) ?? '';
    expect(note).toContain('RELAVIUM_OPENAI_API_KEY');
    expect(note.split('RELAVIUM_OPENAI_API_KEY')).toHaveLength(2); // named once
    expect(note).not.toContain('export');
    expect(note).not.toContain('shell');
    expect(note).not.toContain('synthetic-first-run-key');
    expect(note).toContain('OpenAI'); // the display name, not `openai`
  });
});

describe('a provider is named the way a person reads it', () => {
  it('the stored line names Anthropic and the missed default points at an Anthropic model', async () => {
    const result = await run({
      initialProvider: 'anthropic',
      validation: OK,
      answers: [],
      defaultResult: new Error('private store detail'),
    });
    const text = result.notes.join('\n');
    expect(text).toContain('Verified and stored your Anthropic key');
    expect(text).toContain('Pick an Anthropic model with /models');
    expect(text).not.toContain('your anthropic key');
    expect(text).not.toContain('private store detail');
  });

  it('an unverified save says how to check it with the check that exists on this surface (the doctor’s deep tier), not by opening a chat', async () => {
    const result = await run({
      initialProvider: 'openai',
      validation: NETWORK,
      answers: ['continue'],
    });
    const text = result.notes.join('\n');
    expect(text).toContain(
      "Saved: Your OpenAI key is in the OS keychain, but it couldn't be verified now. Check it later with /doctor, then [d].",
    );
    expect(text).not.toContain('Open a chat');
    expect(text).not.toContain('Run /doctor');
  });

  // Round 2, U3: a key kept after a failed check was saved, not connected, and the card must not say a connection that was never made.
  it('an unverified key is `Saved`, never `Connected`, on the card and in what the Home keeps as its notice', async () => {
    const result = await run({
      initialProvider: 'anthropic',
      validation: NETWORK,
      answers: ['continue'],
    });
    expect(result.finalNote.startsWith('Saved: ')).toBe(true);
    expect(result.notes.join('\n')).not.toContain('Connected');
    expect(result.finalNote).not.toContain('Saved: Saved');
  });

  it('a verified key stays `Connected`', async () => {
    const result = await run({ initialProvider: 'anthropic', validation: OK, answers: [] });
    expect(result.finalNote.startsWith('Connected: Verified and stored your Anthropic key')).toBe(
      true,
    );
    expect(result.notes.join('\n')).not.toContain('Saved:');
  });

  it('shows no stale `Verification` label above the failure of a check (an owned Home run)', async () => {
    const result = await run({
      initialProvider: 'anthropic',
      validation: NETWORK,
      answers: ['skip'],
      owned: true,
    });
    expect(result.notes.join('\n')).not.toContain('Verification');
    expect(result.notes.join('\n')).not.toContain('Checking your Anthropic key');
  });
});
