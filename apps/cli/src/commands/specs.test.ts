import { describe, expect, it } from 'vitest';

import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';

/**
 * Structural / routing coverage for the command registration (specs.ts). The command CORES are behavior-tested
 * in their own files; here we assert the 2.I read commands are wired and — critically — that `gate list` routes
 * to the gate-list subcommand while `gate <runId>` routes to the parent gate action (the one restructuring of
 * the 2.G `gate` command). A help-only program (no context) is used so the actions are clean stubs that throw
 * a command-specific message, which the routing assertions key on without touching the history db.
 */
describe('command registration (specs)', () => {
  it('registers the 2.I read commands and the gate list subcommand', () => {
    const program = buildProgram(captureIo().io);
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining(['list', 'logs', 'status', 'gate', 'chat', 'chat-list']),
    );

    const gate = program.commands.find((command) => command.name() === 'gate');
    expect(gate?.commands.map((command) => command.name())).toContain('list');
  });

  it('routes `relavium chat` to its command (a clean no-context stub in a help-only program)', () => {
    const program = buildProgram(captureIo().io);
    program.exitOverride();
    expect(() => program.parse(['node', 'relavium', 'chat'])).toThrow(/`relavium chat` requires/);
  });

  it('routes `relavium chat-list` to its command (a clean no-context stub in a help-only program)', () => {
    const program = buildProgram(captureIo().io);
    program.exitOverride();
    expect(() => program.parse(['node', 'relavium', 'chat-list'])).toThrow(
      /`relavium chat-list` requires/,
    );
  });

  it('routes `gate list` to the gate-list subcommand (not the parent gate action)', () => {
    const program = buildProgram(captureIo().io);
    program.exitOverride();
    // The help-only subcommand action throws a `gate list`-specific not-implemented message.
    expect(() => program.parse(['node', 'relavium', 'gate', 'list'])).toThrow(/gate list/);
  });

  it('routes `gate <runId>` to the parent gate action', () => {
    const program = buildProgram(captureIo().io);
    program.exitOverride();
    expect(() => program.parse(['node', 'relavium', 'gate', 'abc-123'])).toThrow(
      /`relavium gate` requires/,
    );
  });

  it('gives the documented "not available yet" message for the unshipped chat-family + budget stubs', () => {
    // commands.md promises a clean "not available yet (lands in …)" message — not commander's "unknown
    // command" — for the next chat-family / budget commands. These are registered as stubs (C1).
    for (const argv of [
      ['chat-resume', 'sess-1'],
      ['chat-export', 'sess-1'],
      ['budget', 'resume', 'run-1'],
    ]) {
      const program = buildProgram(captureIo().io);
      program.exitOverride();
      expect(() => program.parse(['node', 'relavium', ...argv])).toThrow(/is not available yet/);
    }
  });
});
