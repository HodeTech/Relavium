import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

import type { AgentDefinition } from '@relavium/core';
import type { ProviderId } from '@relavium/llm';

import { CliError } from '../process/cli-error.js';
import { readAgentFile } from '../workflows/catalog.js';

/**
 * Starting a chat bound to one of the project's agents from the Home
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3, MVP-8 step 5): `c` on
 * an agent's detail page. The Home adds no authority. The agent is bound by the same session build `relavium chat --agent <ref>` uses, with the
 * same consent gate for the MCP servers it declares and the same per-tool approval at every call (ADR-0057, ADR-0084). What differs is how the
 * file is read, and only to read it harder: `--agent` reads an explicit path with a plain stat and read, and the Home reads the file the
 * agents list showed through the catalog's hardened single-file read ({@link readAgentFile}), ONCE, and binds the definition that read produced.
 * This module also refuses an agent that is no longer the one the person read, and turns every refusal into a sentence the Home can show: fixed,
 * and never built from the file or the error.
 */

/** The agent a `c` asks for: the file the page showed (the catalog's own path of it), and the definition that page was drawn from. */
export interface HomeAgentRequest {
  /** The catalog's path of the file, relative to the Home's working directory; never text a person typed and never a row's label. */
  readonly path: string;
  /** The parsed definition the agents list held when the page was drawn: what the person read, compared with what is read at `c`. */
  readonly listed: AgentDefinition;
}

/**
 * Why an agent could not be started, as a closed set: each is a fixed sentence, so nothing of a file or an error reaches the screen. The
 * sentence is whole (not a reason after a shared prefix) because `changed` is not a failure to start so much as the list being out of date.
 */
const NOTICES = {
  invalid: 'The agent could not be started: its definition is not valid.',
  unreadable: 'The agent could not be started: its file is missing or cannot be read.',
  no_key: 'The agent could not be started: its provider has no usable key (see /providers).',
  unbuilt: 'The agent could not be started: its session could not be built.',
  changed: 'The agent changed since it was listed. Open the list again.',
} as const;

export type AgentStartReason = keyof typeof NOTICES;

/** The sentence the Home shows for `reason`: the same words everywhere, taken from nothing but the closed set above. */
export function agentStartNotice(reason: AgentStartReason): string {
  return NOTICES[reason];
}

/**
 * A chat that could not start bound to an agent, for a reason this module classified before anything was built. A {@link CliError} of the
 * invalid-invocation kind, so the session host's failure observer treats it as a refusal and not as an internal fault; the Home reads only
 * {@link HomeAgentStartError.reason}.
 */
export class HomeAgentStartError extends CliError {
  readonly reason: AgentStartReason;
  constructor(reason: AgentStartReason, cause?: unknown) {
    super(
      'invalid_invocation',
      agentStartNotice(reason),
      cause === undefined ? undefined : { cause },
    );
    this.name = 'HomeAgentStartError';
    this.reason = reason;
  }
}

/**
 * The reason the Home shows for a build that failed with `error`: a classified refusal says its own, and anything else (a server that was
 * not approved, one that did not start, a fault) is the closed set's `unbuilt`. The error's message is never read.
 */
export function agentStartReasonOf(error: unknown): AgentStartReason {
  return error instanceof HomeAgentStartError ? error.reason : 'unbuilt';
}

export interface ResolveHomeAgentOptions {
  readonly cwd: string;
  /** The project's `.relavium/` directory as it is found now; `undefined` ⇒ there is no project to read an agent from. */
  readonly projectConfigDir: string | undefined;
  /** The operator home the project-artifact rule reads: the Home's own, so nothing falls back to the process's. */
  readonly homeDir: string;
  /** Whether a provider has a resolvable key: a boolean, never the key (the session build asks the same question again). */
  readonly hasKey: (id: ProviderId) => boolean;
}

/** The agent a `c` binds: the definition the one read produced, and the file's absolute path for the consent prompt (ADR-0084 §7). */
export interface HomeChatAgent {
  readonly agent: AgentDefinition;
  readonly artifact: string;
}

/**
 * Read the agent `request` names, ONCE, and refuse early what the session build would refuse late.
 *
 * The file is read through the catalog's hardened single-file read: admitted project artifact, inside the catalog root (a link out of the
 * project is refused), a regular file (a FIFO is never opened for reading), a size ceiling, an open that follows no final link, and an exact
 * device and inode identity. The definition that read produced is what the caller binds; the file is not read again, so nothing can change
 * between the check and the bind. Then, in this order: a definition that differs at all from the one the page was drawn from is `changed`
 * (a deep structural comparison of the parsed definitions, not of scrubbed text, so a prompt, a tool, a server or a model edited in any way
 * is caught, and an edit the page did not show too); and a provider with no key is `no_key`. A file that is gone, refused by the read or
 * unreadable is `unreadable`, and one that does not parse is `invalid`. Each is a {@link HomeAgentStartError} with a fixed reason.
 *
 * `request.path` is relative to `options.cwd`. The agents list and this read share the Home's working directory (`deps.global.cwd`), which
 * is what makes the label a path; it is made absolute here, once, and the absolute path is what the consent prompt names.
 */
export function resolveHomeChatAgent(
  request: HomeAgentRequest,
  options: ResolveHomeAgentOptions,
): HomeChatAgent {
  if (options.projectConfigDir === undefined) throw new HomeAgentStartError('unreadable');
  const file = resolve(options.cwd, request.path);
  const read = readAgentFile({
    path: file,
    cwd: options.cwd,
    projectConfigDir: options.projectConfigDir,
    homeDir: options.homeDir,
  });
  if (read.kind === 'refused') throw new HomeAgentStartError('unreadable');
  if (read.kind === 'invalid') throw new HomeAgentStartError('invalid');
  if (!isDeepStrictEqual(read.agent, request.listed)) throw new HomeAgentStartError('changed');
  if (!options.hasKey(read.agent.provider)) throw new HomeAgentStartError('no_key');
  return { agent: read.agent, artifact: file };
}
