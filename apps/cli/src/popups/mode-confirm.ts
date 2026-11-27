/**
 * The persistent write of the startup default, drawn as a popup: THE ONE confirmation and Done step of `/mode`, whichever surface asked for it
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6, with its dated note of
 * 2026-11-27; [MVP-11 unit 8 §6](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md), OD-25). A chat's `[s]` and the Home's `Enter` on another
 * mode both come here, and nowhere else: one component, one wording, two entry points (`mode-home.ts` is the Home's, the chat's is wired in
 * `commands/chat.ts` and the Home's chat in `home/drive-home.tsx`).
 *
 * This module changes the SURFACE the startup-default writer's own flow is drawn on, never its authority: it RUNS `runStartupDefaultSave`
 * (`chat/mode-settings.ts`) exactly as it is, so every guard, record and admission stays that flow's: the confirmation that defaults to No, the
 * revocation a confirmed narrowing makes, the config-rewrite disclosure on the visible frame, the visibly admitted publication, `auto`'s risk
 * sentence before its question and its admission only after it was written. The list that chose the mode is the popup host's
 * (`mode-popup.ts`); a selection alone saves nothing.
 *
 * - **The rail is `Mode · Confirm · Done`**, `Mode` being the list the person has just left (drawn done). `Confirm` is the channel's chord card
 *   (`NativeChordPort.chord`): what is written (`default_mode = <mode>`), to which file, that saving rewrites it, what stays for this chat, and
 *   for `auto` the risk sentence before the question. Only an `allow` the chord guard let through confirms (the lockout runs from the card's
 *   appearance, a held key never confirms); `Ctrl+N`, `Ctrl+C`, a closed host and every other key confirm nothing. `Esc` steps back: the flow
 *   ends and the outcome says `back`, so the list opens again on the mode chosen (nothing was done before the confirmation).
 * - **`Done` is persistent** (§6): a write that happened, or one that failed, is said on the popup's last step with the file it went to,
 *   closed by `Enter` or `Esc`. A confirmation declined is ONE notification, and a refusal before anything was asked (the configuration could
 *   not be read) is the flow's own sentence as that one notification, never a Done step.
 *
 * What the confirmation says is built here from the writer's own message: the writer's question is split into its risk sentence and the
 * override it names (`splitConfirmMessage`); a message that is not in that shape is drawn whole, so a disclosure of the writer is never lost.
 * Nothing here is stored text (the modes are a closed set; the target is the caller's scrubbed words).
 */

import { existsSync } from 'node:fs';

import type { ChatMode } from '@relavium/shared';

import { MODE_EFFECT } from '../chat/mode-effects.js';
import {
  runStartupDefaultSave,
  startupDefaultResultOf,
  type StartupDefaultSaveOptions,
  type StartupDefaultSaveResult,
} from '../chat/mode-settings.js';
import { framedFlow, type FramedChordFlow } from '../home/framed-flow.js';
import {
  NATIVE_PROMPT_BACK,
  type NativeChordPort,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { startupDefaultAnnouncement } from './mode-popup.js';
import type { StartupDefaultOutcome } from './settings-port.js';

/** The popup's name on its top edge: the command, as on every other popup. */
export const MODE_CONFIRM_TITLE = '/mode';
/** The rail's steps: the list the person left, the confirmation, the persistent result. */
export const MODE_CONFIRM_STEPS = ['Mode', 'Confirm', 'Done'] as const;
const CONFIRM_STEP = 1;

/** The chord card's two answers (the legend names them: `Ctrl+Y Save it`, `Ctrl+N Save nothing`). */
export const MODE_SAVE_LABEL = 'Save it';
export const MODE_KEEP_LABEL = 'Save nothing';

/** What a confirmation declined (or cancelled at the card) says: the one notification of a flow that wrote nothing. */
export const STARTUP_UNCHANGED = startupDefaultAnnouncement('ask', { kind: 'unchanged' });

/** The question of the confirmation, for `mode`. */
export function confirmQuestion(mode: ChatMode): string {
  return `Save ${mode} as your startup default?`;
}
/** What the confirmation says it writes. */
export function confirmWritesLine(mode: ChatMode): string {
  return `Writes default_mode = ${mode} for new chats.`;
}
/** Where it writes, `target` being the file as a person reads it (the caller's scrubbed words). */
export function confirmFileLine(target: string): string {
  return `File: ${target}`;
}
/** What saving does to a file that exists: the rewrite the writer discloses again on its own frame before it publishes. */
export const CONFIRM_REWRITE_LINE =
  'Saving rewrites the file: its comments and ordering are not kept.';
/** What saving does where there is no file yet: nothing is lost, so nothing is said to be. */
export const CONFIRM_CREATES_LINE = 'Saving creates the file.';
/** What stays for the chat the person is in (a chat only: the Home has none). */
export function confirmChatStaysLine(inChat: ChatMode): string {
  return `This chat stays in ${inChat} mode.`;
}
/** `auto` only: what the startup default means in a terminal, in addition to the risk sentence above the question. */
export const CONFIRM_AUTO_LINE = 'New chats in a terminal then start in auto mode.';

/** The writer's own question for `mode` (`chat/mode-settings.ts`): the shape {@link splitConfirmMessage} reads. */
function writerQuestion(mode: ChatMode): string {
  return `Save ${mode} as the global startup default?`;
}

/** What the writer's message says, split: the risk sentence before its question (`auto` only) and the override it names after it. */
export interface ConfirmParts {
  readonly risk?: string | undefined;
  readonly override?: string | undefined;
}

/**
 * The writer's message for `mode` split into the parts the card draws on their own rows, or `undefined` for a message that is not the writer's
 * known shape (`[risk ]Save <mode> as the global startup default?[ <override>]`): the card then draws the message whole, so a sentence the
 * writer adds or rewords is never dropped, only left unsplit.
 */
export function splitConfirmMessage(message: string, mode: ChatMode): ConfirmParts | undefined {
  const risk = mode === 'auto' ? `${MODE_EFFECT.auto.full} ` : '';
  const head = `${risk}${writerQuestion(mode)}`;
  if (!message.startsWith(head)) return undefined;
  const rest = message.slice(head.length);
  if (rest !== '' && !rest.startsWith(' ')) return undefined;
  const override = rest.trim();
  return {
    ...(risk === '' ? {} : { risk: MODE_EFFECT.auto.full }),
    ...(override === ''
      ? {}
      : { override: `${override.charAt(0).toUpperCase()}${override.slice(1)}` }),
  };
}

/** What the confirmation is built from. */
export interface ConfirmFacts {
  readonly mode: ChatMode;
  /** The file as a person reads it (`~/.relavium/config.toml`), already through the caller's scrub. */
  readonly target: string;
  /** Whether the file exists now: saving then rewrites it (and says so), else it creates it. */
  readonly exists: boolean;
  /** The mode in force in this chat, said to stay; absent on the Home. */
  readonly inChat?: ChatMode | undefined;
  readonly parts: ConfirmParts | undefined;
}

/**
 * The confirmation's body, one row per entry: what is written, `auto`'s extra line (only where the writer's message was understood and names no
 * override: a project or workspace setting that selects another mode says the opposite), the file and what saving does to it, the override the
 * writer names, and what stays for this chat. Never empty: the file is always named.
 */
export function confirmDetails(facts: ConfirmFacts): readonly string[] {
  const { mode, parts } = facts;
  return [
    confirmWritesLine(mode),
    ...(mode === 'auto' && parts !== undefined && parts.override === undefined
      ? [CONFIRM_AUTO_LINE]
      : []),
    confirmFileLine(facts.target),
    facts.exists ? CONFIRM_REWRITE_LINE : CONFIRM_CREATES_LINE,
    ...(parts?.override === undefined ? [] : [parts.override]),
    ...(facts.inChat === undefined ? [] : [confirmChatStaysLine(facts.inChat)]),
  ];
}

/**
 * What the chord card says, from the writer's own message: the card's message and its body. The question is ITS OWN line:
 * - a message in a shape not known is drawn whole as the card's message (a disclosure of the writer is never dropped);
 * - without a risk sentence (every mode but `auto`) the message is the question and the body follows;
 * - with `auto`'s risk sentence the message is the risk text and the body opens with a blank row and then the question, so the question is never
 *   wrapped into the risk's paragraph (a chord card carries no note of a flow, `native-prompt-channel.ts`: the text on it is a decision about
 *   what it says, so the risk has to be the card's own words, and it comes first).
 */
export function confirmCard(
  writerMessage: string,
  facts: ConfirmFacts,
): { readonly message: string; readonly details: readonly string[] } {
  const { mode, parts } = facts;
  const body = confirmDetails(facts);
  if (parts === undefined) return { message: writerMessage, details: body };
  if (parts.risk === undefined) return { message: confirmQuestion(mode), details: body };
  return { message: parts.risk, details: ['', confirmQuestion(mode), ...body] };
}

/** What the flow is given: the options of the writer's startup branch without its words, and where the confirmation is drawn. */
export type StartupDefaultFlowDeps = Omit<StartupDefaultSaveOptions, 'flow' | 'notice'> & {
  /** The channel's flow, with the chord card. */
  readonly flow: NativePromptFlow & NativeChordPort;
  /** Where the popup says it was opened from: the top edge's origin. */
  readonly origin: 'home' | 'chat';
  /** The mode in force in this chat (a chat only): the confirmation says it stays. */
  readonly inChat?: ChatMode | undefined;
  /** The file the startup default is written to, as a person reads it, already through the full scrub: drawn on the confirmation and on the Done step. */
  readonly target: string;
  /** Where a fault that escapes the flow is reported first (the host's work owner); the outcome is then a refusal, or what the flow had said. */
  readonly failure?: ((cause: unknown) => void) | undefined;
};

/** What one run of the flow came to, as the adapter saw it. */
interface Observed {
  /** The confirmation was asked (a later end without a write is a decline, said in one notification). */
  asked: boolean;
  /** The confirmation was stepped back from with `Esc`. */
  steppedBack: boolean;
  /** The flow's one sentence (`runStartupDefaultSave`'s `notice`), never drawn on a notice of its own. */
  said: string | undefined;
}

/**
 * The flow `runStartupDefaultSave` is given: the framed flow, its confirmation asked as the chord card on `Confirm`, the writer's own
 * "Effective startup" note left out (the list marks the default and the card names an override). Nothing else of the flow changes.
 */
function adaptedFlow(
  framed: FramedChordFlow,
  signal: AbortSignal,
  deps: StartupDefaultFlowDeps,
  mode: ChatMode,
  seen: Observed,
): NativePromptFlow {
  return {
    ...framed,
    note: () => undefined,
    confirm: async (message) => {
      seen.asked = true;
      const card = confirmCard(message, {
        mode,
        target: deps.target,
        exists: existsSync(deps.runtime.configPath),
        inChat: deps.inChat,
        parts: splitConfirmMessage(message, mode),
      });
      const answer = await framed.at(CONFIRM_STEP).chord({
        message: card.message,
        details: card.details,
        allow: MODE_SAVE_LABEL,
        deny: MODE_KEEP_LABEL,
        escape: 'back',
        signal,
      });
      if (answer === NATIVE_PROMPT_BACK) seen.steppedBack = true;
      // Only an `allow` the chord guard let through confirms: never "anything that is not a `deny`".
      return typeof answer === 'symbol' ? answer : answer === 'allow';
    },
  };
}

/** Whether a result says more than its Done sentence does (an override, a restart, an unconfirmed durability, a refusal): its sentence is then drawn under it. */
function saysMore(result: StartupDefaultSaveResult): boolean {
  if (result.kind !== 'saved') return true;
  return (
    result.overriddenBy !== undefined ||
    result.autoAfterRestart ||
    result.unfinished ||
    result.durability !== 'confirmed'
  );
}

/**
 * What the popup ends with once the flow has: `back` for an `Esc` on the confirmation, the Done step for a write that happened or failed
 * (`said`), the one notification of a confirmation declined, the flow's own sentence as that one notification when it refused before it asked
 * anything (the configuration could not be read: unit 7 round 2 sitting #3, where the popup said nothing at all), or `closed` for a popup
 * closed before its confirmation.
 */
async function finish(
  framed: FramedChordFlow,
  seen: Observed,
  deps: StartupDefaultFlowDeps,
  mode: ChatMode,
): Promise<StartupDefaultOutcome> {
  if (seen.steppedBack && seen.said === undefined) return { kind: 'back' };
  const result = startupDefaultResultOf(seen.said);
  // A refusal before the confirmation was asked has no Done step to name a mode on: its sentence ("Mode settings could not be completed.
  // Startup default unchanged.") is what the person is told.
  if (result.kind === 'refused' && !seen.asked)
    return seen.said === undefined ? { kind: 'closed' } : { kind: 'notice', text: seen.said };
  if (result.kind === 'unchanged')
    return seen.asked ? { kind: 'notice', text: STARTUP_UNCHANGED } : { kind: 'closed' };
  await framed.done({
    message: startupDefaultAnnouncement(mode, result),
    target: deps.target,
    ...(saysMore(result) && seen.said !== undefined ? { lines: [seen.said] } : {}),
    tone: result.kind === 'saved' ? 'ok' : 'failed',
  });
  return { kind: 'said' };
}

/** What a fault that escaped the flow says when nothing had been said: nothing was saved. */
function refusedOutcome(mode: ChatMode): StartupDefaultOutcome {
  return {
    kind: 'notice',
    text: startupDefaultAnnouncement(mode, { kind: 'refused', autoRevoked: false }),
  };
}

/**
 * Run the persistent write of the startup default for `mode` as a popup (see the module header) and say what it came to. **Never rejects**: a
 * fault that escapes is the host's (`deps.failure`) and the outcome is a refusal, unless the flow had already said its result. The frame is
 * begun here and ended here, around the flow, so it is one box from the confirmation to the Done step.
 */
export async function runStartupDefaultFlow(
  deps: StartupDefaultFlowDeps,
  mode: ChatMode,
): Promise<StartupDefaultOutcome> {
  const framed = framedFlow(deps.flow, {
    title: MODE_CONFIRM_TITLE,
    origin: deps.origin,
    stepNames: MODE_CONFIRM_STEPS,
    progress: 'manual',
  });
  const signal = framed.begin();
  const seen: Observed = { asked: false, steppedBack: false, said: undefined };
  let outcome = refusedOutcome(mode);
  try {
    await runStartupDefaultSave(
      {
        runtime: deps.runtime,
        cwd: deps.cwd,
        interactive: deps.interactive,
        assertAdmitting: deps.assertAdmitting,
        publish: deps.publish,
        ...(deps.prepare === undefined ? {} : { prepare: deps.prepare }),
        flow: adaptedFlow(framed, signal, deps, mode, seen),
        notice: (text) => {
          seen.said = text;
        },
      },
      mode,
    );
    outcome = await finish(framed, seen, deps, mode);
  } catch (cause) {
    deps.failure?.(cause);
    // A fault after the flow said its result does not unsay it (a flow that said none is a refusal): the sentence is then ONE notification,
    // since the Done step could not be drawn.
    if (seen.said !== undefined)
      outcome = {
        kind: 'notice',
        text: startupDefaultAnnouncement(mode, startupDefaultResultOf(seen.said)),
      };
  } finally {
    try {
      await framed.end();
    } catch (cause) {
      deps.failure?.(cause);
    }
  }
  return outcome;
}

/** What a chat hands the flow: everything of {@link StartupDefaultFlowDeps} but what is the chat's own (its origin on the top edge). */
export type ChatStartupDefaultDeps = Omit<StartupDefaultFlowDeps, 'origin' | 'inChat'>;

/**
 * Save `mode` as the startup default from a chat's `[s]`: the shared confirmation, framed as `from chat`, saying the chat stays in `inChat`.
 * The Home's entry is `mode-home.ts`; the two differ in nothing but the origin and that line. Never rejects.
 */
export function saveChatStartupDefault(
  deps: ChatStartupDefaultDeps,
  mode: ChatMode,
  inChat: ChatMode,
): Promise<StartupDefaultOutcome> {
  return runStartupDefaultFlow({ ...deps, origin: 'chat', inChat }, mode);
}
