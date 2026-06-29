import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';
import { COMMAND_MANIFEST, MANIFEST_BY_ID } from './manifest.js';
import { STUB_COMMANDS } from './specs.js';

/**
 * The command-manifest drift guard ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C). The manifest is the single source the `commander` parser, the `executeCommand` table, and
 * `--help --json` all derive from; this test pins them together so they can never diverge: every real `commander`
 * command must have a matching manifest entry with the SAME command description AND the SAME description for each
 * of its options (the `--help --json` text). The in-REPL `/` palette + slash commands are a SEPARATE
 * `REPL_COMMANDS` registry (repl-commands.ts — ADR-0056 amendment), never the manifest, so `commander == manifest`.
 */

/** Permanent parent-only containers — a parent whose only real form is a subcommand; never a manifest entry. */
const CONTAINER_PATHS = ['agent', 'provider'] as const;
/**
 * The not-yet-available stubs are excluded too — but **derived from `STUB_COMMANDS`**, not hardcoded, so a stub
 * that graduates to a real command (removed from `STUB_COMMANDS` + given a real registration) automatically stops
 * being excluded and this test then *requires* a manifest entry for it (fail-loud, never a silent gap).
 */
const NON_COMMAND_PATHS = new Set<string>([
  ...CONTAINER_PATHS,
  ...STUB_COMMANDS.map((stub) => stub.name),
]);

interface CommandNode {
  readonly id: string; // the dotted manifest id (`provider.set-key`)
  readonly description: string;
  readonly command: Command;
}

/** Walk the `commander` tree, yielding every command node (parent and leaf) as a dotted id + its description. */
function collectCommandNodes(command: Command, prefix: string): CommandNode[] {
  const nodes: CommandNode[] = [];
  for (const sub of command.commands) {
    const path = prefix === '' ? sub.name() : `${prefix} ${sub.name()}`;
    nodes.push({ id: path.replaceAll(' ', '.'), description: sub.description(), command: sub });
    nodes.push(...collectCommandNodes(sub, path));
  }
  return nodes;
}

describe('command manifest (ADR-0056)', () => {
  it('parses + deep-freezes at module load (no duplicate ids, schema-valid, immutable entries)', () => {
    expect(COMMAND_MANIFEST.length).toBeGreaterThan(0);
    expect(Object.isFrozen(COMMAND_MANIFEST)).toBe(true);
    const ids = COMMAND_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(MANIFEST_BY_ID.size).toBe(ids.length);
    // Deep freeze: every entry and its args (items + array) are immutable, not just the top-level array.
    for (const entry of COMMAND_MANIFEST) {
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.args !== undefined) {
        expect(Object.isFrozen(entry.args)).toBe(true);
        for (const arg of entry.args) expect(Object.isFrozen(arg)).toBe(true);
      }
    }
  });

  it('every real commander command has a matching manifest entry (command + option descriptions) — surfaces cannot diverge', () => {
    const program = buildProgram(captureIo().io);
    const commandNodes = collectCommandNodes(program, '').filter(
      (node) => !NON_COMMAND_PATHS.has(node.id),
    );

    // No real command is missing from the manifest.
    const manifestIds = new Set(COMMAND_MANIFEST.map((entry) => entry.id));
    const missing = commandNodes.filter((node) => !manifestIds.has(node.id)).map((node) => node.id);
    expect(missing).toEqual([]);

    for (const node of commandNodes) {
      const entry = MANIFEST_BY_ID.get(node.id);
      // The command description matches commander's `--help` text.
      expect(entry?.description).toBe(node.description);
      // Every commander OPTION is in the manifest's args with the SAME description (the --help --json text), so
      // an option-description edit in specs.ts that is not mirrored in the manifest fails CI. The manifest arg
      // name is the camelCase `CommandInput.options` key — commander's `attributeName()` (`--base-url` → `baseUrl`),
      // so the manifest, the dispatch extractor, and a slash surface all agree on the key.
      for (const option of node.command.options) {
        const key = option.attributeName();
        const arg = entry?.args?.find((candidate) => candidate.name === key);
        expect(arg, `manifest ${node.id} is missing option arg '${key}'`).toBeDefined();
        expect(arg?.description).toBe(option.description);
      }
    }
  });

  it('every manifest arg carries a description (a complete, glanceable palette/help surface)', () => {
    for (const entry of COMMAND_MANIFEST) {
      for (const arg of entry.args ?? []) {
        expect(arg.description, `${entry.id} arg '${arg.name}' has no description`).toBeTruthy();
      }
    }
  });

  it('the destructive annotation marks credential removal (the one destructive entry today)', () => {
    const destructive = COMMAND_MANIFEST.filter((entry) => entry.effect === 'destructive');
    expect(destructive.map((entry) => entry.id)).toEqual(['provider.remove-key']);
  });
});
