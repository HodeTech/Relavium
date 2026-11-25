/**
 * What each chat mode DOES, in one place ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6 and
 * §3): the sentence the `/mode` popup states under the highlighted mode and the startup-default confirmation names, and the few words the
 * notification after a change into the mode carries, so a key (`Shift+Tab`), a typed argument (`/mode auto`) and the popup all say the
 * same thing and none of them skips the risk text.
 *
 * The wording follows what the policy actually does ([ADR-0130](../../../../docs/decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md),
 * [ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md),
 * [ADR-0138](../../../../docs/decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)): in `accept-edits` a file
 * edit is applied without a card while a command, the network and an ambient OS action still ask, and a protected path is refused; in `auto`
 * a granted action is approved without a card, but a command still asks unless the operator remembered it or approved it for the session
 * (never because the repository's allowlist names it), and the scope and protected-path rules hold in every mode.
 *
 * A data module (ADR-0145 §10): no `ink`, no `react`, no Node built-in; the CLI's data-module fence covers it.
 */
import type { ChatMode } from '@relavium/shared';

/** One mode's effect, said twice. */
export interface ModeEffect {
  /** The whole effect as one sentence: what the popup states under the highlighted mode and what a confirmation of the mode names. */
  readonly full: string;
  /** The effect in a few words, after the mode's name in the notification that follows a change into it (`auto mode · …`). */
  readonly short: string;
}

/** The effect of every mode (the one source; ADR-0148 §6). */
export const MODE_EFFECT: Readonly<Record<ChatMode, ModeEffect>> = {
  ask: {
    full: 'Every write, command and network call asks first.',
    short: 'every action asks first',
  },
  plan: {
    full: 'Read-only: nothing is changed, and the agent drafts a plan first.',
    short: 'read-only, nothing is changed',
  },
  'accept-edits': {
    full: 'Files are edited without asking; commands and network still ask, and protected paths stay refused.',
    short: 'files are edited without asking',
  },
  auto: {
    full: 'Granted actions are approved without asking; a command still asks unless you remembered or approved it, and scope and protected-path rules still apply.',
    short: 'granted actions run without asking',
  },
};

/**
 * How much each mode lets happen without a card, lowest first: `plan` changes nothing, `ask` asks before every governed action,
 * `accept-edits` applies file edits unasked, `auto` approves every granted action unasked. Not the `Shift+Tab` cycle order (which starts
 * at `ask`); this is the order a mode change WIDENS or NARROWS authority in.
 */
export const MODE_AUTHORITY_RANK: Readonly<Record<ChatMode, number>> = {
  plan: 0,
  ask: 1,
  'accept-edits': 2,
  auto: 3,
};

/** The authority rank of `mode` (see {@link MODE_AUTHORITY_RANK}): higher lets more happen without a card. */
export function modeAuthorityRank(mode: ChatMode): number {
  return MODE_AUTHORITY_RANK[mode];
}

/**
 * Whether a change from `from` to `to` WIDENS authority (the new mode ranks higher). The lead's amended D-4 (ADR-0148 §6): a widening is
 * applied only once its record row landed, and refused otherwise; a narrowing always applies, its record best effort, because refusing it
 * would keep the session in the wider mode.
 */
export function widensAuthority(from: ChatMode, to: ChatMode): boolean {
  return modeAuthorityRank(to) > modeAuthorityRank(from);
}

/**
 * The modes whose every change INTO them is announced with its effect, whatever started it (ADR-0148 §6): the two that approve something
 * without a card. A change into `ask` or `plan` narrows, and the status line, which shows the mode, is its confirmation.
 */
const ANNOUNCED_MODES: ReadonlySet<ChatMode> = new Set<ChatMode>(['accept-edits', 'auto']);

/** Whether a change into `mode` is announced with its effect (`accept-edits` and `auto`). */
export function announcesEffect(mode: ChatMode): boolean {
  return ANNOUNCED_MODES.has(mode);
}

/** The notification after a change into `mode` (or a typed `/mode <name>` that found it already in force): its name and its short effect. */
export function modeChangedNotice(mode: ChatMode): string {
  return `${mode} mode · ${MODE_EFFECT[mode].short}`;
}

/**
 * The one line a WIDENING mode change that could not be recorded says instead of changing (ADR-0148 §6: a widening is applied only once
 * its content-free record is in the session; a lost record of authority is refused rather than dropped). A narrowing never says it: it
 * applies whether or not its row landed ({@link widensAuthority}). Within the 54 columns a notification has beside a popup's way back
 * (`POPUP_NOTICE_MAX_COLUMNS`).
 */
export const MODE_NOT_RECORDED_NOTICE = 'Mode not changed: the change could not be recorded.';
