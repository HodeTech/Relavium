import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';
import { COMMAND_MANIFEST, MANIFEST_BY_ID } from './manifest.js';

/**
 * The command-manifest drift guard ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C). The manifest is the single source the `commander` parser, the `/` palette, and `--help --json` all
 * derive from; this test pins them together so they can never diverge: every real `commander` command must have
 * a matching manifest entry with the SAME description (the `--help --json` text). The manifest may carry extra
 * slash-only entries (`/help`, `/doctor`, …) with no `commander` command — those are added by later 2.5.C steps,
 * so this is a `commander ⊆ manifest` invariant, not equality.
 */

/** Containers (a parent whose only real form is a subcommand) + not-yet-available stubs — not invokable cores. */
const NON_COMMAND_PATHS = new Set(['agent', 'provider', 'budget', 'init']);

interface CommandNode {
  readonly id: string; // the dotted manifest id (`provider.set-key`)
  readonly description: string;
}

/** Walk the `commander` tree, yielding every command node (parent and leaf) as a dotted id + its description. */
function collectCommandNodes(command: Command, prefix: string): CommandNode[] {
  const nodes: CommandNode[] = [];
  for (const sub of command.commands) {
    const path = prefix === '' ? sub.name() : `${prefix} ${sub.name()}`;
    nodes.push({ id: path.replaceAll(' ', '.'), description: sub.description() });
    nodes.push(...collectCommandNodes(sub, path));
  }
  return nodes;
}

describe('command manifest (ADR-0056)', () => {
  it('parses + freezes at module load (no duplicate ids, schema-valid)', () => {
    expect(COMMAND_MANIFEST.length).toBeGreaterThan(0);
    expect(Object.isFrozen(COMMAND_MANIFEST)).toBe(true);
    const ids = COMMAND_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(MANIFEST_BY_ID.size).toBe(ids.length);
  });

  it('every real commander command has a matching manifest entry (id + description) — surfaces cannot diverge', () => {
    const program = buildProgram(captureIo().io);
    const commandNodes = collectCommandNodes(program, '').filter(
      (node) => !NON_COMMAND_PATHS.has(node.id),
    );

    // No real command is missing from the manifest.
    const manifestIds = new Set(COMMAND_MANIFEST.map((entry) => entry.id));
    const missing = commandNodes.filter((node) => !manifestIds.has(node.id)).map((node) => node.id);
    expect(missing).toEqual([]);

    // The manifest description matches commander's `--help` text for every command (the `--help --json` contract).
    for (const node of commandNodes) {
      expect(MANIFEST_BY_ID.get(node.id)?.description).toBe(node.description);
    }
  });

  it('the destructive annotation marks credential removal (the one destructive entry today)', () => {
    const destructive = COMMAND_MANIFEST.filter((entry) => entry.effect === 'destructive');
    expect(destructive.map((entry) => entry.id)).toEqual(['provider.remove-key']);
  });
});
