/**
 * The declared-child-environment denylist
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §4).
 *
 * It lived inside `run_command`'s host and covered only that spawn, while the MCP stdio path — which starts a
 * program a shared artifact names — passed every declared variable through untouched. These tests exist to
 * keep one list true of both hosts, and to state what each category is FOR, because a denylist whose reasons
 * are not written down grows by accident and shrinks by accident.
 */

import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { McpServerRefSchema } from './agent.js';
import { McpServerRegistrationSchema } from './config.js';
import {
  forbiddenDeclaredEnvNames,
  forbiddenDeclaredEnvPrefixes,
  isForbiddenDeclaredEnvKey,
} from './declared-env.js';

describe('isForbiddenDeclaredEnvKey', () => {
  it('refuses each category, and says which by naming a member of it', () => {
    // Interpreter / loader option + module-path injection — measured on the pinned MCP SDK: `NODE_OPTIONS`
    // ran a preload before the target script.
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'PERL5OPT',
      'RUBYOPT',
      'CLASSPATH',
      'BASH_ENV',
    ]) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(true);
    }
    // The dynamic loaders and the whole git / python configuration namespaces, by PREFIX.
    for (const key of ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'PYTHONPATH']) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(true);
    }
    // Config-home redirection — repoints a tool's rc file at an attacker-authored one.
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'APPDATA']) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(true);
    }
    // And `PATH`, because executable resolution deliberately ignores a declared value — rejecting it is
    // honest where accepting it would mislead.
    expect(isForbiddenDeclaredEnvKey('PATH')).toBe(true);
  });

  it('is CASE-INSENSITIVE, because Windows environment names are', () => {
    // A set of uppercase strings would let `node_options` walk straight past it.
    for (const key of ['node_options', 'Node_Options', 'dyld_insert_libraries', 'path']) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(true);
    }
  });

  it('refuses EVERY member of the list, and the count is pinned', () => {
    // A review measured ten of the original twenty-two deletable with the whole monorepo green: the tests
    // sampled the list instead of iterating it. Sampling a denylist is how one shrinks by accident.
    for (const name of forbiddenDeclaredEnvNames()) {
      expect(isForbiddenDeclaredEnvKey(name), name).toBe(true);
      expect(isForbiddenDeclaredEnvKey(name.toLowerCase()), name).toBe(true);
    }
    for (const prefix of forbiddenDeclaredEnvPrefixes()) {
      expect(isForbiddenDeclaredEnvKey(`${prefix}ANYTHING`), prefix).toBe(true);
    }
    // The counts are the part that makes a DELETION red rather than merely unasserted.
    expect(forbiddenDeclaredEnvNames()).toHaveLength(31);
    expect(forbiddenDeclaredEnvPrefixes()).toHaveLength(6);
  });

  it('covers the vectors a review measured executing code, not just the ones already known', () => {
    // Each of these was run, not reasoned about. `ZDOTDIR` is `BASH_ENV`'s vector for macOS's DEFAULT shell:
    // pointing it at a directory holding a `.zshenv` ran that file before the target command. And
    // `NPM_CONFIG_USERCONFIG` redirected npm's resolved registry — which lands on ADR-0084 §3's own
    // canonical example, `npx -y @acme/server`, where it would repoint an APPROVED fingerprint's package.
    for (const key of [
      'ZDOTDIR',
      'NPM_CONFIG_USERCONFIG',
      'npm_config_registry',
      'BASH_FUNC_x%%',
    ]) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(true);
    }
    // `PATHEXT` for the same stated reason as `PATH`: resolution reads it, so accepting it would mislead.
    expect(isForbiddenDeclaredEnvKey('PATHEXT')).toBe(true);
  });

  it('permits an ordinary declared variable — the list is narrow, not a blanket refusal', () => {
    for (const key of ['ACME_TOKEN', 'API_BASE', 'LOG_LEVEL', 'MY_APP_HOME', 'NODE_ENV']) {
      expect(isForbiddenDeclaredEnvKey(key), key).toBe(false);
    }
  });

  it('`PYTHON` has no trailing underscore, and that is deliberate', () => {
    // `PYTHONHOME` / `PYTHONPATH` / `PYTHONINSPECT` carry none either, so a `PYTHON_` prefix would miss
    // every one of them.
    expect(isForbiddenDeclaredEnvKey('PYTHONHOME')).toBe(true);
    expect(isForbiddenDeclaredEnvKey('PYTHONINSPECT')).toBe(true);
  });
});

/** Every issue's message and path, flattened — what a renderer would put on a terminal. */
function issueTexts(parsed: {
  readonly error: { readonly issues: readonly z.ZodIssue[] };
}): string {
  return parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.')} ${issue.message}`)
    .join('\n');
}

describe('both stdio entry points are held to the one list (ADR-0084 §4)', () => {
  const inline = (env: Record<string, string>): ReturnType<typeof McpServerRefSchema.safeParse> =>
    McpServerRefSchema.safeParse({ id: 'fs', transport: 'stdio', command: 'node', env });
  const registration = (
    env: Record<string, string>,
  ): ReturnType<typeof McpServerRegistrationSchema.safeParse> =>
    McpServerRegistrationSchema.safeParse({
      name: 'fs',
      transport: 'stdio',
      command: 'node',
      env,
    });

  it('an INLINE `mcp_servers` entry rejects a denylisted key at parse', () => {
    // Rejected at PARSE rather than at the consent gate: a declaration that can redirect the loader must
    // never reach a prompt, because the prompt would then be deciding about the wrong program.
    const parsed = inline({ NODE_OPTIONS: '--require /tmp/x.js' });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toContain('NODE_OPTIONS');
    expect(inline({ ACME_TOKEN: '{{secrets.acme}}' }).success).toBe(true);
  });

  it('a `[[mcp_servers]]` REGISTRATION rejects the same key at parse', () => {
    // The other way a stdio server reaches a spawn. Exempting it would leave the rule true of one entry
    // point and not the other, which is how the gap this closes came to exist in the first place.
    const parsed = registration({ dyld_insert_libraries: '/tmp/evil.dylib' });
    expect(parsed.success).toBe(false);
    expect(registration({ ACME_TOKEN: 'x' }).success).toBe(true);
  });

  it('a NETWORK transport is unaffected — it forbids `env` outright already', () => {
    // The first version asserted only that a network ref WITHOUT `env` parses, which stayed green when the
    // `env` rejection was deleted. The claim in the title is the rejection, so that is what is asserted.
    expect(
      McpServerRefSchema.safeParse({
        id: 'api',
        transport: 'http',
        url: 'https://example.com/mcp',
      }).success,
    ).toBe(true);
    expect(
      McpServerRefSchema.safeParse({
        id: 'api',
        transport: 'http',
        url: 'https://example.com/mcp',
        env: { ACME: '1' },
      }).success,
    ).toBe(false);
  });

  it('names a forbidden key only when the key is ECHO-SAFE, and bounds how many it names', () => {
    // The blocker. An env key's charset is unconstrained, a `custom` issue's message is returned verbatim by
    // the parser, and `relavium list` writes that to stdout with no sanitizer on the path — a review
    // reproduced `ESC[2J` and `U+202E` on a real terminal, twice per line. An author who used the portable
    // charset still gets told WHICH variable; anyone else gets a message naming the field and nothing else.
    const hostile = 'GIT_\u001b[2J\u202Edrowssap';
    const parsed = inline({ [hostile]: 'x' });
    expect(parsed.success).toBe(false);
    const issue = !parsed.success ? issueTexts(parsed) : '';
    expect(issue).not.toContain('\u001b');
    expect(issue).not.toContain('\u202E');

    // …and the bound, so a hostile file cannot produce an issue per key.
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) many[`GIT_VAR_${String(i)}`] = 'x';
    const capped = inline(many);
    expect(!capped.success && capped.error.issues.length).toBeLessThanOrEqual(8);
  });
});
