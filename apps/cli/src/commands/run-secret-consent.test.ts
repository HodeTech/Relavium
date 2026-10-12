import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryHost } from '@relavium/core';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { buildEngine } from '../engine/build-engine.js';
import { fingerprint, resolveStdioSpawn } from '../engine/mcp-consent.js';
import * as consent from '../engine/mcp-consent-gate.js';
import { isCliError } from '../process/errors.js';
import { captureIo } from '../test-support.js';
import { runCommand } from './run.js';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn(() => Promise.resolve(false)) }));
vi.mock('../mcp/consent-prompt.js', () => ({ createConsentPrompter: () => prompt }));

let root: string;
let priorHome: string | undefined;
let priorProfile: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-secret-consent-'));
  priorHome = process.env['HOME'];
  priorProfile = process.env['USERPROFILE'];
  process.env['HOME'] = root;
  process.env['USERPROFILE'] = root;
  prompt.mockClear();
});
afterEach(() => {
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorProfile;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function workflow(): string {
  const path = join(root, 'consent.relavium.yaml');
  writeFileSync(
    path,
    `schema_version: '1.0'
workflow:
  id: secret-consent
  inputs:
    - { name: token, type: secret }
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
  nodes:
    - { id: start, type: input }
    - { id: agent, type: agent, agent_ref: worker, prompt_template: synthetic }
    - { id: out, type: output }
  edges:
    - { from: start, to: agent }
    - { from: agent, to: out }
`,
  );
  return path;
}

function fixture() {
  const capture = captureIo();
  // Deliberately stale prompt-facing metadata: a real successful pipe read must override it. A
  // normally projected non-TTY io alone would not witness removal of the consumed-stdin policy.
  const io = { ...capture.io, stdinIsTty: true, stdoutIsTty: true, env: {} };
  const startMcpClient = vi.fn(() => realStartMcpClient([]));
  const providers = scriptedResolver([textTurn('finished')]);
  const gate = vi.spyOn(consent, 'createConsentGate'); // call through to the actual consent decision
  const readSecretInput = vi.fn(() => Promise.resolve('token=opaqueConsentValue'));
  return {
    capture,
    startMcpClient,
    gate,
    readSecretInput,
    deps: {
      io,
      global: {
        cwd: root,
        json: false,
        color: false,
        verbosity: 'normal',
        configPath: undefined,
      } as const,
      providers,
      startMcpClient,
      readSecretInput,
      buildEngine: () => buildEngine({ providers, host: createInMemoryHost() }),
      selectRenderer: () => ({ onEvent: () => {}, finalize: () => {} }),
    },
  };
}

describe('consumed run stdin uses the actual MCP consent gate', () => {
  it('refuses unapproved stdio without prompting or starting a client despite stale TTY metadata', async () => {
    const f = fixture();
    let caught: unknown;
    try {
      await runCommand(
        { workflow: workflow(), input: [], allowMcpStdio: [], secretInputsStdin: true },
        f.deps,
      );
    } catch (error) {
      caught = error;
    }
    expect(isCliError(caught) && caught.code).toBe('invalid_invocation');
    expect(prompt, 'SECRETS_CAUSAL_RUN_CONSUMED_STDIN_CONSENT').not.toHaveBeenCalled();
    expect(f.startMcpClient).not.toHaveBeenCalled();
    expect(f.readSecretInput).toHaveBeenCalledOnce();
    expect(
      f.gate.mock.calls[0]?.[0].io.stdinIsTty,
      'SECRETS_CAUSAL_RUN_CONSENT_TTY_PROJECTION',
    ).toBe(false);
    expect(f.capture.err()).toMatch(/v1:[a-f0-9]{64}/);
    expect(existsSync(consent.mcpConsentPath(root))).toBe(false);
  });

  it('honors the exact explicit digest without prompting or appending an approval', async () => {
    const f = fixture();
    const spawn = await resolveStdioSpawn(
      { serverId: 'local', command: process.execPath, provenance: { kind: 'inline' } },
      root,
    );
    const digest = fingerprint(spawn);
    expect(
      await runCommand(
        { workflow: workflow(), input: [], allowMcpStdio: [digest], secretInputsStdin: true },
        f.deps,
      ),
    ).toBe(0);
    expect(f.startMcpClient).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    expect(f.readSecretInput).toHaveBeenCalledOnce();
    expect(existsSync(consent.mcpConsentPath(root))).toBe(false);
  });

  it('still offers the existing consent prompt on an ordinary interactive invocation', async () => {
    const f = fixture();
    await expect(
      runCommand({ workflow: workflow(), input: [], allowMcpStdio: [] }, f.deps),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(prompt).toHaveBeenCalledOnce();
    expect(f.startMcpClient).not.toHaveBeenCalled();
    expect(f.readSecretInput).not.toHaveBeenCalled();
    expect(existsSync(consent.mcpConsentPath(root))).toBe(false);
  });
});
