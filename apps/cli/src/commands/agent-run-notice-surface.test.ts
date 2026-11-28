import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { GlobalOptions } from '../process/options.js';
import * as signalPorts from '../process/signals.js';
import { captureIo } from '../test-support.js';
import { agentRunCommand } from './agent-run.js';

/**
 * A scripted `agent run` reads SHELL wording (MVP-11 Step 2 review, C6). The notices the session host composes were fixed to the TUI wording, so
 * a one-shot run printed `warning: ... Open /models and press Ctrl+R ...` to stderr, a remedy a script cannot follow. A new file: the pinned
 * counts of `chat.test.ts` and `run.test.ts` belong to the causal and secrets controls, and `agent-run.test.ts` is large enough already.
 */
// An agent whose model the catalog does not know and which asks for a reasoning tier: the gate withholds the tier and the host says so.
const UNKNOWN_MODEL_AGENT = [
  'id: coder',
  'provider: anthropic',
  'model: my-self-hosted-model',
  'reasoning_effort: high',
  'system_prompt: You are a coder.',
  'tools:',
  '  - read_file',
].join('\n');
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

describe('agent run, the scripted path', () => {
  let cwd: string;
  let home: string;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.spyOn(signalPorts, 'defaultSubscribeSignals').mockReturnValue(() => undefined);
    cwd = mkdtempSync(join(tmpdir(), 'relavium-agentrun-surface-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-agentrun-surface-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
    }
    writeFileSync(join(cwd, 'coder.agent.yaml'), UNKNOWN_MODEL_AGENT);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the shell remedy for a withheld tier on stderr, and never a command of the TUI', async () => {
    const { io, err } = captureIo();
    const control = invocationFixture();
    const global: GlobalOptions = {
      json: false,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    const code = await agentRunCommand(
      { agent: join(cwd, 'coder.agent.yaml'), input: [], allowMcpStdio: [] },
      {
        invocation: control.invocation,
        io: { ...io, stdin: Readable.from(['synthetic prompt']) },
        global,
        now: () => 0,
        uuid: () => 'a-0',
        providers: scriptedResolver([textTurn('done')]),
      },
    );
    expect(code).toBe(0);
    const text = err();
    expect(text).toContain('warning: ');
    expect(text, 'the remedy a script can run').toContain('relavium models refresh');
    expect(text, 'no TUI remedy on a script’s stderr').not.toMatch(/\/models|Ctrl\+R|\/pricing/u);
  });
});
