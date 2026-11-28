/**
 * The MCP consent card of a hosted leg
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4,
 * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md)).
 *
 * "Nothing was spawned" is proven with a COUNTER at the process boundary (the injected `startMcpClient`, which is the call that
 * starts a stdio server), through the real gate and the real connect path, not by reading a flag the card keeps. Every home the gate
 * reads and writes is a temporary directory.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '@relavium/core';
import { render, type Key } from 'ink';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConsentGate,
  mcpConsentPath,
  type ConsentSubject,
} from '../engine/mcp-consent-gate.js';
import { fingerprint, resolveStdioSpawn } from '../engine/mcp-consent.js';
import { connectWorkflowMcp } from '../engine/mcp-servers.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { flush } from '../render/tui/harness-util.js';
import { NativePromptHost } from '../render/tui/native-prompt-host.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
} from '../render/tui/native-prompt-channel.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import {
  askConsent,
  consentCardText,
  createNativeConsentPrompter,
  CONSENT_ALLOW_LABEL,
  CONSENT_PATH_REFUSED,
} from './consent-card.js';

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

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-consent-card-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const subject = (over: Partial<ConsentSubject> = {}): ConsentSubject => ({
  serverId: 'files',
  provenance: 'inline',
  artifact: undefined,
  resolvedCommand: '/usr/local/bin/node',
  authoredCommand: undefined,
  args: [],
  env: [],
  cwd: '/work/project',
  digest: 'v1:abcdef',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
  ...over,
});

describe('the card says what Ctrl+Y does', () => {
  it('names the server and says "on this machine", never "for this run"', () => {
    const text = consentCardText(subject({ serverId: 'files' }));
    const everything = [text.message, text.allow, text.deny, ...text.details].join('\n');
    expect(text.message).toContain("'files'");
    expect(text.message).toContain('on this machine');
    expect(text.allow).toContain('on this machine');
    expect(everything).not.toContain('for this run');
    expect(everything).not.toMatch(/this run\b/);
    expect(text.allow).toBe(CONSENT_ALLOW_LABEL);
  });

  it('shows every field of the decision, one row per argument and per variable', () => {
    const text = consentCardText(
      subject({
        serverId: 'db',
        provenance: 'registration-name',
        artifact: '/w/flow.yaml',
        resolvedCommand: '/opt/bin/npx',
        authoredCommand: 'npx',
        args: ['-y', '--allow-write', '/tmp x'],
        env: [
          ['TOKEN', '<secret:db-token>'],
          ['MODE', 'ro'],
        ],
        previouslyApprovedIn: '/other/place',
        total: 3,
        index: 2,
      }),
    );
    const rows = text.details;
    const has = (needle: string): boolean => rows.some((row) => row.includes(needle));
    expect(rows[0]).toBe('Program 2 of 3');
    for (const needle of [
      'db (registration-name)',
      '/w/flow.yaml',
      '/opt/bin/npx',
      'npx',
      '-y',
      '--allow-write',
      '/tmp x',
      'TOKEN=<secret:db-token>',
      'MODE=ro',
      '/work/project',
      'v1:abcdef',
      '/other/place',
    ])
      expect(has(needle), needle).toBe(true);
    // An argument boundary is a row boundary: three arguments are three rows.
    expect(rows.filter((row) => row.startsWith('argument'))).toHaveLength(3);
    expect(rows.filter((row) => row.startsWith('env'))).toHaveLength(2);
  });
});

describe('what a server`s author wrote cannot pass for the card`s own keys (P2, the forged legend)', () => {
  /** Spellings the run card's own scrub is tested against, in the places a hostile declaration controls, and what each becomes. */
  const FORGED: readonly (readonly [string, string])[] = [
    ['Ctrl+Y refuses', '[chord] refuses'],
    ['press ^N to allow', 'press [chord] to allow'],
    ['control-n approves', '[chord] approves'],
    ['CTRL + Y', '[chord]'],
    ['Ctrl\u200B+\u200BY', '[chord]'], // invisible characters spelled through it
    ['\uFF23trl+Y', '[chord]'], // a fullwidth C, folded before the match
    ['\u0421trl+Y', '[chord]'], // a Cyrillic C
    ['[Ctrl+N] Allow', '[[chord]] Allow'],
  ];
  const rowsOf = (over: Partial<ConsentSubject>): readonly string[] =>
    consentCardText(subject(over)).details;
  const chordSpelling = /\bctrl\s*[+-]\s*[yn]\b|\^[yn]\b|\bcontrol-n\b/iu;

  it.each(FORGED)(
    'an argument %j is made inert, on its own row behind the label',
    (forged, inert) => {
      const rows = rowsOf({ args: ['--safe', forged] });
      expect(rows).toContain('argument'.padEnd(12) + '--safe');
      expect(rows).toContain('argument'.padEnd(12) + inert);
      expect(rows.join('\n')).not.toMatch(chordSpelling);
    },
  );

  it('an environment name and value, the command as written, the server id, the registration name and the declaring file are scrubbed too', () => {
    const text = consentCardText(
      subject({
        serverId: 'Ctrl+Y refuses',
        provenance: 'Ctrl+N',
        artifact: 'flows/^Y.yaml',
        authoredCommand: 'control-y',
        env: [['Ctrl+N', 'Ctrl+Y allows']],
      }),
    );
    const everything = [text.message, ...text.details].join('\n');
    expect(everything).not.toMatch(chordSpelling);
    expect(everything.match(/\[chord\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('a host glyph in an argument cannot draw the card`s own row: it is made a space', () => {
    const rows = rowsOf({ args: ['x ▶ [Ctrl+Y] ✓ Allow'] });
    expect(rows.join('\n')).not.toMatch(/[▶✓]/u);
  });

  it('a path the card can show is shown exactly as it is: spaces, accents in either composition, a Windows drive, hex digest', () => {
    for (const path of [
      '/opt/node/bin/node',
      '/Users/Müller Ünal/My Tools/srv',
      '/Users/mu\u0308ller/bin/node', // an accent in decomposed form, as a Mac volume can hand it back
      'C:\\Program Files\\nodejs\\node.exe',
      '/work/x^2/control a process/node',
    ]) {
      const rows = rowsOf({ resolvedCommand: path, cwd: path, previouslyApprovedIn: path });
      expect(rows).toContain('executable'.padEnd(12) + path);
      expect(rows).toContain('directory'.padEnd(12) + path);
      expect(rows).toContain(`(you approved this same program in ${path})`);
      expect(rows).toContain('digest'.padEnd(12) + 'v1:abcdef');
    }
  });

  describe('a path the scrub would change is refused, never shown and never rewritten (M1)', () => {
    const HOSTILE_PATHS = [
      '/repo/tools/Ctrl+Y refuses this - Ctrl+N allows/srv',
      '/repo/^Y/srv',
      '/repo/control-n/srv',
      '/repo/\uFF23trl+Y/srv', // a fullwidth C
      '/repo/\u0421trl+Y/srv', // a Cyrillic C
      '/repo/Ctrl\u200B+\u200BY/srv', // an invisible character spelled through it
      '/repo/\u2502 [Ctrl+Y] Allow/srv', // a box-drawing line, the gutter of the card's own rows
      '/repo/\u2713 approved/srv',
      '/repo/\u25B6 run/srv',
      '/repo/\u001b[2Jsrv',
      '/repo/\u202Eevil/srv', // a bidi override
      '/repo/tab\tsrv',
    ];
    const FIELDS = ['resolvedCommand', 'cwd', 'previouslyApprovedIn'] as const;

    it.each(HOSTILE_PATHS.flatMap((path) => FIELDS.map((field) => [path, field] as const)))(
      'path %j in %s: no card text is built, with fixed words that carry no path',
      (path, field) => {
        let thrown: unknown;
        try {
          consentCardText(subject({ [field]: path }));
        } catch (cause) {
          thrown = cause;
        }
        expect(isCliError(thrown), 'a typed refusal').toBe(true);
        const message = isCliError(thrown) ? thrown.message : '';
        expect(message).toBe(CONSENT_PATH_REFUSED);
        expect(message).not.toContain('/repo');
        expect(message).not.toContain('Ctrl');
        expect(isCliError(thrown) && thrown.code).toBe('invalid_invocation');
      },
    );

    // an executable bit and these characters are POSIX facts
    it.skipIf(process.platform === 'win32')(
      'the real case: a repository executable named like a legend resolves, and is refused before a card opens, with nothing started',
      async () => {
        const repo = mkdtempSync(join(tmpdir(), 'relavium-consent-forged-path-'));
        try {
          const dir = join(repo, 'tools', 'Ctrl+Y refuses this - Ctrl+N allows');
          mkdirSync(dir, { recursive: true });
          const exe = join(dir, 'srv');
          writeFileSync(exe, '#!/bin/sh\nexit 0\n');
          chmodSync(exe, 0o755);
          const spawn = await resolveStdioSpawn(
            {
              serverId: 'docs',
              provenance: { kind: 'inline' },
              command: './tools/Ctrl+Y refuses this - Ctrl+N allows/srv',
            },
            repo,
          );
          const forged = subject({
            serverId: 'docs',
            resolvedCommand: spawn.resolvedCommand,
            authoredCommand: spawn.command,
            cwd: spawn.cwd,
            digest: fingerprint(spawn),
          });
          const channel = createNativePromptChannel();
          channel.flow.begin();
          const kinds: string[] = [];
          channel.ui.subscribe(() => kinds.push(channel.ui.getSnapshot().kind));
          await expect(createNativeConsentPrompter(channel.flow)(forged)).rejects.toMatchObject({
            code: 'invalid_invocation',
            message: CONSENT_PATH_REFUSED,
          });
          expect(kinds, 'no chord card was ever published').not.toContain('chord');
          await channel.flow.end();
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      },
    );

    // an executable bit and these characters are POSIX facts
    it.skipIf(process.platform === 'win32')(
      'through the real gate and connect path: refused with those words, nothing spawned, no grant written, no card published',
      async () => {
        const dir = join(home, 'tools', 'Ctrl+Y refuses this - Ctrl+N allows');
        mkdirSync(dir, { recursive: true });
        const exe = join(dir, 'srv');
        writeFileSync(exe, '#!/bin/sh\nexit 0\n');
        chmodSync(exe, 0o755);
        const channel = createNativePromptChannel();
        channel.flow.begin();
        const kinds: string[] = [];
        channel.ui.subscribe(() => kinds.push(channel.ui.getSnapshot().kind));
        const start = vi.fn(() => Promise.reject(new Error('the server was started')));
        const gate = createConsentGate({
          io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true, env: {} },
          global: {
            json: false,
            color: false,
            cwd: home,
            configPath: undefined,
            verbosity: 'normal',
          },
          homeDir: home,
          allowedDigests: [],
          prompt: createNativeConsentPrompter(channel.flow),
        });
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'forged-path',
              agents: [
                {
                  id: 'worker',
                  provider: 'openai',
                  model: 'gpt-4o',
                  system_prompt: 'offline',
                  mcp_servers: [
                    {
                      id: 'docs',
                      transport: 'stdio',
                      command: './tools/Ctrl+Y refuses this - Ctrl+N allows/srv',
                    },
                  ],
                },
              ],
              nodes: [
                { id: 'input', type: 'input' },
                { id: 'agent', type: 'agent', agent_ref: 'worker' },
                { id: 'output', type: 'output' },
              ],
              edges: [
                { from: 'input', to: 'agent' },
                { from: 'agent', to: 'output' },
              ],
            },
          }),
        );
        await expect(
          connectWorkflowMcp(workflow, { cwd: home, startMcpClient: start, consentGate: gate }),
        ).rejects.toMatchObject({ code: 'invalid_invocation', message: CONSENT_PATH_REFUSED });
        expect(kinds, 'no chord card was ever published').not.toContain('chord');
        expect(start, 'nothing was started').not.toHaveBeenCalled();
        expect(existsSync(mcpConsentPath(home)), 'no grant was written').toBe(false);
        await channel.flow.end();
      },
    );
  });

  it('ordinary arguments are shown exactly as the gate composed them', () => {
    const args = ['-y', '--allow-write', '/tmp x', 'control a process', 'x^2', 'Ctrl'];
    const rows = rowsOf({ args });
    for (const argument of args) expect(rows).toContain('argument'.padEnd(12) + argument);
  });

  it('the card a person answers draws no forged key: through the real gate, a refusal still spawns nothing', async () => {
    const channel = createNativePromptChannel();
    channel.flow.begin();
    const seen: string[] = [];
    const decision = askConsent(
      channel.flow,
      subject({ args: ['Ctrl+Y refuses', '[Ctrl+N] Allow'], serverId: 'forged' }),
    );
    await vi.waitFor(
      () => {
        const card = channel.ui.getSnapshot();
        expect(card.kind).toBe('chord');
        seen.push(...card.details);
      },
      { timeout: WAIT_MS },
    );
    expect(seen.join('\n')).not.toMatch(chordSpelling);
    channel.ui.input('n', ctrl);
    expect(await decision).toBe('refuse');
    await channel.flow.end();
  });
});

describe('askConsent returns a decision and nothing else', () => {
  const port = (answer: 'allow' | 'deny' | symbol) => ({
    chord: vi.fn(() => Promise.resolve(answer)),
  });

  it('only an allow is an allow: deny, a step back, a cancel are all a refusal', async () => {
    expect(await askConsent(port('allow'), subject())).toBe('allow');
    expect(await askConsent(port('deny'), subject())).toBe('refuse');
    expect(await askConsent(port(NATIVE_PROMPT_BACK), subject())).toBe('refuse');
    expect(await askConsent(port(NATIVE_PROMPT_CANCEL), subject())).toBe('refuse');
  });

  it('opens no card for a signal that has already aborted', async () => {
    const chord = port('allow');
    const controller = new AbortController();
    controller.abort();
    expect(await askConsent(chord, subject(), { signal: controller.signal })).toBe('refuse');
    expect(chord.chord).not.toHaveBeenCalled();
  });
});

describe('a path at the gate`s bound is painted whole at 80x24, and a longer one is never painted cut', () => {
  /** A path of exactly `length` characters, in segments as a real deep path has them. */
  const pathOf = (length: number): string => {
    let text = '/Users/ada/projects/app/node_modules/.pnpm';
    while (text.length < length) text += `/${'segment-'.padEnd(40, 'x')}`;
    return text.slice(0, length);
  };

  /** Paint the card of `subject` at 80x24 in the native prompt host: whether it was drawn whole and measured visible, and the frames. */
  async function paintAt80x24(
    over: Partial<ConsentSubject>,
  ): Promise<{ outcome: 'whole' | 'does-not-fit'; painted: string }> {
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    output.columns = 80;
    output.rows = 24;
    const channel = createNativePromptChannel();
    const instance = render(
      createElement(NativePromptHost, {
        ui: channel.ui,
        color: false,
        onRendererReady: () => undefined,
      }),
      {
        stdin: input,
        stdout: output,
        stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: false,
      },
    );
    try {
      channel.flow.begin();
      const asked = askConsent(
        channel.flow,
        subject({
          artifact: '/Users/ada/projects/app/flows/agent.yaml',
          authoredCommand: './node_modules/.bin/docs-server',
          digest: `v1:${'a'.repeat(64)}`,
          ...over,
        }),
      );
      let outcome: 'whole' | 'does-not-fit' = 'does-not-fit';
      await vi.waitFor(
        () => {
          const card = channel.ui.getSnapshot();
          expect(card.kind).toBe('chord');
          if (output.frames.join('').includes('Prompt does not fit')) return;
          channel.ui.assertVisible(card);
          outcome = 'whole';
        },
        { timeout: WAIT_MS },
      );
      channel.flow.cancel();
      expect(await asked).toBe('refuse');
      await channel.flow.end();
      // The rows as text: cursor and erase sequences, the gutter and every line break and padding taken out.
      const painted = output.frames
        .join('')
        .replace(new RegExp(String.raw`\u001B\[[0-9;?]*[A-Za-z]`, 'g'), '')
        .replace(/│/g, '')
        .replace(/\s+/g, '');
      return { outcome, painted };
    } finally {
      channel.ui.dispose();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
  }

  it('the executable and its directory, both at 520 characters (the gate`s MAX_PATH_CHARS), are drawn whole: every character of both', async () => {
    const executable = pathOf(520);
    const directory = `${pathOf(519)}d`;
    const { outcome, painted } = await paintAt80x24({
      resolvedCommand: executable,
      cwd: directory,
    });
    expect(outcome).toBe('whole');
    expect(painted).toContain(executable);
    expect(painted).toContain(directory);
  });

  it('a card too tall for the terminal is not drawn at all, so no path is ever drawn cut', async () => {
    const { outcome, painted } = await paintAt80x24({
      resolvedCommand: pathOf(1000),
      cwd: pathOf(1000),
    });
    expect(outcome).toBe('does-not-fit');
    expect(painted).not.toContain(pathOf(300));
  });
});

describe('a card closes with the work it asks about', () => {
  it('a signal that aborts while the card is open closes it, settles it as a refusal and leaves the flow open', async () => {
    const channel = createNativePromptChannel();
    channel.flow.begin();
    const stop = new AbortController();
    const asked = askConsent(channel.flow, subject(), { signal: stop.signal });
    expect(channel.ui.getSnapshot().kind).toBe('chord');
    stop.abort();
    expect(await asked).toBe('refuse');
    expect(channel.ui.getSnapshot().kind, 'the card is gone').toBe('busy');
    expect(channel.ui.getSnapshot().active, 'the flow is the caller`s to end').toBe(true);
    await channel.flow.end();
  });

  it('a signal that aborts after the card was answered changes nothing, and leaves no listener behind', async () => {
    const channel = createNativePromptChannel({ now: () => 10_000 });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    channel.flow.begin();
    const stop = new AbortController();
    const asked = askConsent(channel.flow, subject(), { signal: stop.signal });
    channel.ui.shown(channel.ui.getSnapshot());
    channel.ui.input('n', ctrl);
    expect(await asked).toBe('refuse');
    // A second card is open now: the first one's abort must not close it.
    const second = askConsent(channel.flow, subject());
    stop.abort();
    expect(channel.ui.getSnapshot().kind, 'the next card is untouched').toBe('chord');
    channel.flow.cancel();
    expect(await second).toBe('refuse');
    await channel.flow.end();
  });
});

/** The real gate and the real connect path over a native chord card, with a counter where a server would be started. */
function harness() {
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  channel.flow.begin();
  const start = vi.fn(() => Promise.reject(new Error('the server was started')));
  const captured = captureIo();
  const global: GlobalOptions = {
    json: false,
    color: false,
    cwd: process.cwd(),
    configPath: undefined,
    verbosity: 'normal',
  };
  const gate = createConsentGate({
    io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true, env: {} },
    global,
    homeDir: home,
    allowedDigests: [],
    now: () => '2026-11-23T00:00:00.000Z',
    prompt: createNativeConsentPrompter(channel.flow),
  });
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'consent-card',
        agents: [
          {
            id: 'worker',
            provider: 'openai',
            model: 'gpt-4o',
            system_prompt: 'offline',
            mcp_servers: [{ id: 'files', transport: 'stdio', command: 'node' }],
          },
        ],
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'agent', type: 'agent', agent_ref: 'worker' },
          { id: 'output', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'agent' },
          { from: 'agent', to: 'output' },
        ],
      },
    }),
  );
  const connect = () =>
    connectWorkflowMcp(workflow, { cwd: process.cwd(), startMcpClient: start, consentGate: gate });
  /** Wait for the card, then let it be painted and read. */
  const cardUp = async (): Promise<void> => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });
    now = 0;
    channel.ui.shown(channel.ui.getSnapshot());
    now = 10_000;
  };
  return { ...channel, start, connect, cardUp, at: (ms: number) => (now = ms) };
}

describe('a refusal spawns nothing', () => {
  const refusals: Array<[string, (f: ReturnType<typeof harness>) => void]> = [
    ['Ctrl+N', (f) => f.ui.input('n', ctrl)],
    ['Esc', (f) => f.ui.input('', { ...none, escape: true })],
    ['Ctrl+C', (f) => f.ui.input('c', ctrl)],
    ['the flow being cancelled under the card', (f) => f.flow.cancel()],
  ];
  it.each(refusals)(
    '%s refuses the server: nothing is started and nothing is recorded',
    async (_name, press) => {
      const f = harness();
      const connecting = f.connect();
      const settled = connecting.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await f.cardUp();
      press(f);
      const outcome = await settled;
      expect(isCliError(outcome)).toBe(true);
      expect(f.start).not.toHaveBeenCalled();
      expect(existsSync(mcpConsentPath(home))).toBe(false);
      await f.flow.end();
    },
  );

  it('a bare letter and a paste neither allow nor refuse: the card stays open, and a refusal after them still starts nothing', async () => {
    const f = harness();
    const connecting = f.connect().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await f.cardUp();
    f.ui.input('y', none);
    f.ui.input('Y', { ...none, shift: true });
    f.ui.paste('y');
    f.ui.paste('\x19');
    await flush();
    expect(f.ui.getSnapshot().kind).toBe('chord');
    expect(f.start).not.toHaveBeenCalled();
    f.at(60_000);
    f.ui.input('n', ctrl);
    expect(isCliError(await connecting)).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    await f.flow.end();
  });
});

describe('an allow reaches the spawn, once, and is remembered on this machine', () => {
  it('Ctrl+Y after the card has settled records the grant and starts the server (the control for the refusals above)', async () => {
    const f = harness();
    const connecting = f.connect().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await f.cardUp();
    f.ui.input('y', ctrl);
    const outcome = await connecting;
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(outcome instanceof Error && outcome.message.includes('the server was started')).toBe(
      true,
    );
    expect(existsSync(mcpConsentPath(home))).toBe(true);
    await f.flow.end();
  });

  it('Ctrl+Y inside the dwell is not an allow: nothing is recorded and nothing is started', async () => {
    const f = harness();
    const connecting = f.connect().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(f.ui.getSnapshot().kind).toBe('chord'), { timeout: WAIT_MS });
    f.at(0);
    f.ui.shown(f.ui.getSnapshot());
    f.at(100); // 100 ms after the frame: too soon to have been read
    f.ui.input('y', ctrl);
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    expect(existsSync(mcpConsentPath(home))).toBe(false);
    f.ui.input('n', ctrl);
    expect(isCliError(await connecting)).toBe(true);
    await f.flow.end();
  });
});
