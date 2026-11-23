import { shortRunId } from '../history/run-detail-model.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import { createSlotSecretPort } from '../render/tui/run-card-model.js';
import type { HostedLaunch, RunHost } from './run-host.js';

/**
 * Continue a run that is parked on media jobs and nothing else, from the Home
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note): one native
 * question, and on a Yes the run host's media resume, which re-attaches the jobs the log recorded and submits nothing again.
 *
 * - **A question, never an action.** The default is No: an `Enter` typed ahead, a closed prompt, `Esc` and `Ctrl+C` all answer No, and a
 *   No (or a prompt that ended without an answer) starts nothing and says nothing: the run stays parked, as it was.
 * - **The host decides what the run is.** This module reads nothing of the run and adds no authority: the request carries the run id and
 *   the secrets port, and the host's resume core refuses a run that is not parked, has a gate to decide, or waits for no media job.
 * - **The same native flow as a gate answer.** A resumed leg may need the Home's own prompts while it prepares (a masked slot, the MCP
 *   consent card), and the channel answers only while a flow is open, so the flow stays open from the answer to the leg's start, never
 *   for the leg itself.
 */

/**
 * What the question says before a Yes, because a Yes has two costs the person must know. The leg runs in THIS Home until the jobs finish
 * (it holds the Home's one leg slot, so a gate answer or `/run` meanwhile is refused as busy), and leaving the Home cancels it: a
 * cancelled run cannot be resumed, and the output of the jobs already paid for is never fetched.
 */
export const MEDIA_CONTINUE_CONSEQUENCE =
  'It runs in this Home until the jobs finish, and leaving the Home cancels it.';

/** The question: the run named by its first characters (cut first, then through the one-line floor), what it costs, the default answer No. */
export function mediaContinueQuestion(runId: string): string {
  return `Run ${shortRunId(runId)} is waiting for media jobs. Continue it here? ${MEDIA_CONTINUE_CONSEQUENCE}`;
}

/** What a left secret field says on this path: there is no gate to name, so it names what did not happen. */
export const MEDIA_CONTINUE_SECRETS_CANCELLED = 'Not continued: the secrets were not entered.';

/** What the Home says when another prompt is already open: a refusal, not a queue. */
export const MEDIA_CONTINUE_PROMPT_OPEN =
  'Another prompt is open. Finish it, then continue the run.';

export interface MediaContinueDeps {
  /** The run host's one resume path: a media continue is the same single-flight leg as a gate answer. */
  readonly host: Pick<RunHost, 'resume'>;
  readonly flow: Pick<NativePromptFlow, 'begin' | 'end' | 'busy' | 'confirm' | 'password'>;
  /** Throws when the Home is closing; called before anything is asked. */
  readonly assertAdmitting?: (() => void) | undefined;
}

/** The sentence the Home shows for the host's answer: the leg that started, or the host's own words for why it did not. */
function launchNotice(launch: HostedLaunch): string {
  if (launch.kind === 'started')
    return `Continuing run ${sanitizeUntrustedInline(launch.runId)}. It runs in the background.`;
  return sanitizeUntrustedInline(launch.message);
}

/**
 * Ask whether to continue `runId`, and continue it only on a Yes. Resolves with the sentence the Home shows, or `undefined` when nothing
 * happened (a No, `Esc`, `Ctrl+C`). The flow is begun here and ended here, whatever the answer.
 */
export async function runMediaContinue(
  deps: MediaContinueDeps,
  runId: string,
): Promise<string | undefined> {
  deps.assertAdmitting?.();
  try {
    deps.flow.begin();
  } catch {
    return MEDIA_CONTINUE_PROMPT_OPEN;
  }
  try {
    // No is the default: only an explicit Yes continues the run.
    const answer = await deps.flow.confirm(mediaContinueQuestion(runId), false, 'cancel');
    if (answer !== true) return undefined;
    deps.flow.busy('Continuing the run…');
    const launch = await deps.host.resume({
      kind: 'media',
      runId,
      secrets: createSlotSecretPort(deps.flow, MEDIA_CONTINUE_SECRETS_CANCELLED),
    });
    return launchNotice(launch);
  } finally {
    // Closing the flow never changes the answer already sent: a leg that started is a started leg (see `createGateResumer`).
    try {
      await deps.flow.end();
    } catch {
      // discarded on purpose: the flow's own owner reports what it needs to
    }
  }
}
