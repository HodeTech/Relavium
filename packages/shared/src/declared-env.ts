/**
 * The declared-child-environment denylist — one rule, shared by every host that spawns a process.
 */

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
  // config-home redirection (repoints ~/.gitconfig, rc files, …; APPDATA/LOCALAPPDATA are the Windows
  // per-user config roots)
  'HOME',
  'XDG_CONFIG_HOME',
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
const FORBIDDEN_DECLARED_ENV_PREFIX = ['DYLD_', 'LD_', 'GIT_', 'PYTHON'] as const;

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
