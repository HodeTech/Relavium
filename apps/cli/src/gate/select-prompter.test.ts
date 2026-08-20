/**
 * Which environments may be ASKED a gate question.
 *
 * The selector asked a rendering question (`detectOutputMode`, which consults stdout) to decide a prompting
 * one, so it never looked at stdin: with stdout on a TTY and stdin piped it handed back a clack prompter
 * whose raw-mode setup throws, turning a run that should pause cleanly with exit `3` into a fault. It
 * delegates to the shared four-way predicate now, alongside the Home gate and the MCP consent gate
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §6).
 */

import { describe, expect, it } from 'vitest';

import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { selectGatePrompter } from './select-prompter.js';

const global = (json = false): GlobalOptions => ({
  json,
  color: false,
  cwd: '/w',
  configPath: undefined,
  verbosity: 'normal',
});

const io = (
  over: { stdoutIsTty?: boolean; stdinIsTty?: boolean; env?: Record<string, string> } = {},
): CliIo => ({
  ...captureIo(over.env ?? {}).io,
  stdoutIsTty: over.stdoutIsTty ?? true,
  stdinIsTty: over.stdinIsTty ?? true,
});

describe('selectGatePrompter', () => {
  it('returns a prompter on a real interactive terminal', () => {
    expect(selectGatePrompter(io(), global())).toBeDefined();
  });

  it('returns undefined with a PIPED STDIN, even though stdout is a TTY', () => {
    expect(selectGatePrompter(io({ stdinIsTty: false }), global())).toBeUndefined();
  });

  it('returns undefined with a piped stdout', () => {
    expect(selectGatePrompter(io({ stdoutIsTty: false }), global())).toBeUndefined();
  });

  it('returns undefined under --json — stdout is a machine stream (ADR-0049)', () => {
    expect(selectGatePrompter(io(), global(true))).toBeUndefined();
  });

  it('returns undefined in CI, where a pseudo-TTY would hang the pipeline', () => {
    expect(selectGatePrompter(io({ env: { CI: 'true' } }), global())).toBeUndefined();
  });
});
