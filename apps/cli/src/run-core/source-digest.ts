import { createHash, timingSafeEqual } from 'node:crypto';

import { CliError } from '../process/errors.js';

/** What a start says when the workflow file is not the one the person confirmed: nothing was started, and the remedy is the sentence. */
export const WORKFLOW_SOURCE_CHANGED =
  'The workflow file changed after you confirmed. Open the list again.';

/**
 * The SHA-256 digest (lowercase hex) of a workflow file's source TEXT, the string `resolveWorkflowSource` returns as `yaml`.
 *
 * It is the one definition both sides use, so what a confirmation was built from and what a start read cannot be digested two ways:
 * the Home's launch catalog calls it on the text it parsed for the form and the confirmation, and `prepareRun` calls it on the text it
 * is about to parse. It is over the decoded text (UTF-8, as the file was read), never over a different view of the bytes, a trimmed
 * copy or a parsed definition.
 *
 * **It binds the workflow file only.** What it does NOT bind: a file the workflow merely names (the CLI reads no external agent file
 * while it prepares a run; an `agent_ref` not declared inline is left to run time); the project files `.relavium/project.toml` and
 * `.relavium/workspace.toml`, which are read after the confirmation and can set `[defaults].fs_scope` and add `mcp_servers`
 * registrations; the global configuration; the consent grant log; the keychain; the pricing and catalog rows; and the MCP tool lists
 * discovered at connect time. A changed MCP command still meets the consent gate, because consent is fingerprinted on the declaration.
 */
export function workflowSourceDigest(yaml: string): string {
  return createHash('sha256').update(yaml, 'utf8').digest('hex');
}

/**
 * Refuse a start whose workflow text is not the one that was confirmed. The comparison is constant-time over two byte strings of the
 * same length; an expected value of any other length (an empty or malformed one included) cannot be equal, and is refused without one.
 * It is a typed `invalid_invocation` carrying {@link WORKFLOW_SOURCE_CHANGED}, which the Home shows as the launch's notice.
 */
export function assertWorkflowSourceDigest(expected: string, yaml: string): void {
  const given = Buffer.from(expected, 'utf8');
  const actual = Buffer.from(workflowSourceDigest(yaml), 'utf8');
  if (given.length !== actual.length || !timingSafeEqual(given, actual))
    throw new CliError('invalid_invocation', WORKFLOW_SOURCE_CHANGED);
}
