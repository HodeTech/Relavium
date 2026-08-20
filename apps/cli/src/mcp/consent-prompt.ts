import { confirm, isCancel, log } from '@clack/prompts';

import type { ConsentPrompter, ConsentSubject } from '../engine/mcp-consent-gate.js';

/**
 * The `@clack/prompts`-backed consent prompt
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7,
 * [ADR-0047](../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md)).
 *
 * The ONLY place `@clack/prompts` is imported on the MCP path, mirroring the gate prompter, the create
 * prompter and the ink renderer split. The narrow slice it uses is injectable so the composition is
 * unit-tested without a TTY — and so the DECISION logic, which lives in `mcp-consent-gate.ts`, never has to
 * know a terminal exists.
 *
 * Every field arrives already sanitized and length-bounded from the gate; this module only lays them out.
 */

/** The narrow slice of `@clack/prompts` this prompt uses — injectable, like every sibling wrapper. */
export interface ClackConsentDeps {
  readonly confirm: (opts: {
    message: string;
    initialValue?: boolean;
  }) => Promise<boolean | symbol>;
  readonly log: { readonly message: (text: string) => void };
  readonly isCancel: (value: unknown) => value is symbol;
}

const DEFAULT_DEPS: ClackConsentDeps = { confirm, log, isCancel };

/**
 * Render one decision and answer it.
 *
 * **Defaults to No.** Clack's `confirm` defaults to Yes, so a bare Enter on a prompt a user did not read
 * would approve a local program — `initialValue: false` is what makes Enter the safe answer, and the repo
 * has no `--yes` convention that would offer a bypass.
 *
 * A cancel (Ctrl-C / ESC) is a refusal, not an absence: the gate treats anything but `true` as "no".
 */
export function createConsentPrompter(deps: ClackConsentDeps = DEFAULT_DEPS): ConsentPrompter {
  return async (subject: ConsentSubject): Promise<boolean> => {
    deps.log.message(render(subject));
    const answer = await deps.confirm({
      message: `Allow MCP server '${subject.serverId}' to run this program?`,
      initialValue: false,
    });
    return !deps.isCancel(answer) && answer === true;
  };
}

/**
 * The decision as separate LINES, never a joined shell string.
 *
 * Argument boundaries are exactly what an escape sequence or a bidi override would blur, so each argument
 * gets its own line — and an environment variable is shown with its authored value, because the environment
 * is the half of a declaration that changes what an executable does. A secret reference shows as
 * `<secret:NAME>`; a resolved credential never reaches this module.
 */
function render(subject: ConsentSubject): string {
  const lines = [
    subject.total > 1
      ? `Program ${String(subject.index)} of ${String(subject.total)}`
      : 'This artifact wants to start a local program.',
    `  server     ${subject.serverId} (${subject.provenance})`,
  ];
  if (subject.artifact !== undefined) lines.push(`  declared in ${subject.artifact}`);
  lines.push(`  executable ${subject.resolvedCommand}`);
  if (subject.authoredCommand !== undefined) {
    // Shown only when the two differ — `npx` → `/opt/homebrew/bin/npx` is the case a user needs to see,
    // because the word is what they wrote and the path is what will run.
    lines.push(`  as written ${subject.authoredCommand}`);
  }
  // ONE line per argument and per variable — never a joined shell string. An escape sequence or a bidi
  // override blurs exactly the boundary between two arguments, so the boundary is a line break the terminal
  // cannot be talked out of (§7).
  lines.push(
    ...subject.args.map((arg) => `  argument   ${arg}`),
    ...subject.env.map(([name, value]) => `  env        ${name}=${value}`),
    `  directory  ${subject.cwd}`,
    `  digest     ${subject.digest}`,
  );
  if (subject.previouslyApprovedIn !== undefined) {
    // Consent is project-scoped (§3), so the same program in a second checkout is asked about again. Saying
    // where it was approved makes that a recognition rather than a fresh decision — which is the mitigation
    // for the fatigue cost §3 accepts, and it is not the same as weakening the identity.
    lines.push(`  (you approved this same program in ${subject.previouslyApprovedIn})`);
  }
  return lines.join('\n');
}
