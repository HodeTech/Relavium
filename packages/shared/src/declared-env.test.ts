/**
 * The declared-child-environment denylist
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §4).
 *
 * It lived inside `run_command`'s host and covered only that spawn, while the MCP stdio path — which starts a
 * program a shared artifact names — passed every declared variable through untouched. These tests exist to
 * keep one list true of both hosts, and to state what each category is FOR, because a denylist whose reasons
 * are not written down grows by accident and shrinks by accident.
 */

import { describe, expect, it } from 'vitest';

import { McpServerRefSchema } from './agent.js';
import { McpServerRegistrationSchema } from './config.js';
import { isForbiddenDeclaredEnvKey } from './declared-env.js';

describe('isForbiddenDeclaredEnvKey', () => {
  it('refuses each category, and says which by naming a member of it', () => {
    // Interpreter / loader option + module-path injection — measured on the pinned MCP SDK: `NODE_OPTIONS`
    // ran a preload before the target script.
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'PERL5OPT', 'RUBYOPT', 'CLASSPATH', 'BASH_ENV']) {
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
    expect(
      McpServerRefSchema.safeParse({
        id: 'api',
        transport: 'http',
        url: 'https://example.com/mcp',
      }).success,
    ).toBe(true);
  });
});
