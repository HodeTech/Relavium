/**
 * The declared-child-environment denylist — one rule, shared by every host that spawns a process.
 */

import { z } from 'zod';

/**
 * Environment variable names a DECLARED child environment may not set
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §4).
 *
 * **One list, both process hosts.** It began inside `run_command`'s host and covered only that spawn, while
 * the MCP stdio path — which spawns a program a shared artifact names — passed every declared variable
 * through untouched. Measured on the pinned SDK: `NODE_OPTIONS` executed a preload before the target script,
 * and a prefixed `PATH` redirected a bare `npx`. Two hosts running one rule is why this is here rather than
 * duplicated; a test asserts they cannot drift apart.
 *
 * The categories, each because it turns a trusted binary into a different program: interpreter and loader
 * option injection and module paths; the entire `GIT_` namespace (`GIT_CONFIG_*`, `GIT_SSH*`, and
 * `core.hooksPath` → arbitrary execution); config-home redirection, which repoints a tool's rc file at an
 * attacker-authored one; and `PATH`, because executable resolution deliberately ignores a declared value.
 */
const FORBIDDEN_DECLARED_ENV: ReadonlySet<string> = new Set([
  // interpreter / loader option + module-path injection
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYLIB',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'BASH_ENV',
  'ENV',
  'IFS',
  'SHELLOPTS',
  'PS4',
  // `ZDOTDIR` is `BASH_ENV`'s vector for the DEFAULT shell on macOS — measured: pointing it at a directory
  // holding a `.zshenv` ran that file before the target command. A declaration may name `zsh` directly, and
  // `shell: false` does not stop it (ADR-0084 Context).
  'ZDOTDIR',
  // Resolution reads `PATHEXT` on Windows, so a declared value steers which candidate is tried first — the
  // same reason `PATH` is refused rather than silently ignored. `COMSPEC` is the Windows shell itself.
  'PATHEXT',
  'COMSPEC',
  // TLS trust and pager/edit hooks: `NODE_EXTRA_CA_CERTS` makes an attacker CA trusted for every outbound
  // request the child makes; `LESSOPEN` is an arbitrary-command filter many tools invoke through a pager.
  'NODE_EXTRA_CA_CERTS',
  'LESSOPEN',
  'PERLLIB',
  // config-home redirection (repoints ~/.gitconfig, rc files, …; APPDATA/LOCALAPPDATA are the Windows
  // per-user config roots)
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CONFIG_DIRS',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  // executable resolution ignores a declared PATH — reject it rather than mislead
  'PATH',
]);

/**
 * Forbidden key PREFIXES: the dynamic loaders and the whole git and python configuration namespaces.
 *
 * `PYTHON` carries no trailing underscore on purpose — `PYTHONHOME` / `PYTHONPATH` / `PYTHONINSPECT` have
 * none either, so a `PYTHON_` prefix would miss every one of them.
 */
const FORBIDDEN_DECLARED_ENV_PREFIX = [
  'DYLD_',
  'LD_',
  'GIT_',
  'PYTHON',
  // `NPM_CONFIG_USERCONFIG` points npm at an attacker-authored `.npmrc` — measured: it changed the resolved
  // registry. That lands squarely on ADR-0084 §3's own canonical example, `npx -y @acme/server`, where it
  // would redirect an APPROVED fingerprint's package resolution. npm also reads the lowercase `npm_config_*`
  // form, which the case-insensitive match above already covers.
  'NPM_CONFIG_',
  // An exported shell function, the shellshock shape — bash reads `BASH_FUNC_x%%` as a definition.
  'BASH_FUNC_',
] as const;

/**
 * The exact names, exported so a test can iterate the LIST rather than a hand-picked sample of it.
 *
 * A review measured ten of the original twenty-two deletable with the whole monorepo green — the same class
 * of gap this project found in its own input-validation bounds, here in a security control. The test asserts
 * every member and pins the count, so removing one is red.
 */
export function forbiddenDeclaredEnvNames(): readonly string[] {
  return [...FORBIDDEN_DECLARED_ENV];
}

/** The prefixes, exported for the same reason. */
export function forbiddenDeclaredEnvPrefixes(): readonly string[] {
  return [...FORBIDDEN_DECLARED_ENV_PREFIX];
}

/**
 * May a declared child environment set this name? **Case-insensitive**, because Windows environment names
 * are, so `node_options` must not slip past a set of uppercase strings.
 */
export function isForbiddenDeclaredEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    FORBIDDEN_DECLARED_ENV.has(upper) ||
    FORBIDDEN_DECLARED_ENV_PREFIX.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * A declared child environment may not steer the interpreter, the dynamic loader, or a tool's config home
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §4).
 *
 * The same rule `run_command`'s host has always enforced, applied here because this declaration spawns a
 * program a shared artifact names — and consent answers "do I trust this program", while a loader variable
 * answers "this is actually a different program". Rejected at PARSE, as an authored error, so it cannot
 * reach a consent prompt that would then be deciding about the wrong thing.
 */
export function validateDeclaredEnv(
  env: Record<string, string> | undefined,
  ctx: z.RefinementCtx,
): void {
  let reported = 0;
  for (const key of Object.keys(env ?? {})) {
    if (!isForbiddenDeclaredEnvKey(key)) continue;
    if (reported >= MAX_REPORTED_ENV_KEYS) break;
    reported += 1;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      // **VALUE-FREE, and the key is only a PATH SEGMENT when it is echo-safe.** An env key's charset is
      // unconstrained — `env` is `z.record(z.string(), z.string())` — and a `custom` issue's `message` is
      // returned verbatim by `parser.ts`'s describeIssue, reaching `relavium list`'s stdout with no
      // sanitizer on that path. A review reproduced `ESC[2J` and `U+202E` on a real terminal, twice per
      // line: once from the message and once from the path. This is the same class removed from the parser
      // in `e9cde2b` and from the engine in `a77c968`, and it is precisely the attack ADR-0084 §7 exists to
      // defend against — landing one commit before the prompt it defends.
      message: envKeyIsEchoSafe(key)
        ? `environment variable '${key}' may not be declared — it can redirect the interpreter, the dynamic loader, or a tool's configuration`
        : `an environment variable may not be declared — it can redirect the interpreter, the dynamic loader, or a tool's configuration`,
      path: envKeyIsEchoSafe(key) ? ['env', key] : ['env'],
    });
  }
}

/**
 * Is this env key safe to interpolate into a message or a field path?
 *
 * The POSIX portable environment-name charset. An author who used it gets told which variable — which is the
 * actionable half — and one who did not gets a message that names the field and nothing else.
 */
function envKeyIsEchoSafe(key: string): boolean {
  return /^[A-Za-z_]\w*$/.test(key); // `\w` is EXACTLY `[A-Za-z0-9_]` in JS; the lead class cannot fold (no digits)
}

/** How many forbidden keys one `env` block reports before the rest are left to the next parse. */
const MAX_REPORTED_ENV_KEYS = 8;
