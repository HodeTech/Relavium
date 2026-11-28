/**
 * The `/doctor` popup's words and rows ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): pure builders from the checks to the popup's
 * three steps (the checks, a row's detail, the deep tier's confirmation line), its copy text and its remedies. The state machine that runs the
 * checks and answers the keys is `doctor-session.ts`; neither is loaded until the person first opens the popup (`doctor-port.ts`).
 *
 * **Every label and detail is untrusted** (a check's detail can carry a configuration error, a provider's answer, an MCP server's skip reason,
 * an id from an agent's YAML), and this surface has a chord step, so the FULL scrub of the run cards applies ({@link scrubPopupText}, the one
 * scrub of every popup, `popup-text.ts`, ADR-0145 §5): the untrusted-text floor with secrets scrubbed, folded, host glyphs blanked, answer chords
 * replaced, and bracketed key tokens and legend separators made inert, so a repository's text cannot draw `[Ctrl+Y]` where the person decides.
 * The provider check's own redaction (the key replaced by its last-four hint, `validateProviderKey`) runs before it.
 *
 * **No line is ever cut.** A report line the frame draws wider than the popup is clipped, so every line written here is wrapped
 * ({@link wrapPopupText}) to the width a popup has at the smallest terminal it is drawn on ({@link POPUP_TEXT_COLUMNS}): an origin the
 * confirmation line names is never shown in part.
 */

import type { ProviderId } from '@relavium/llm';

import {
  ENDPOINT_CHANGED_DETAIL,
  KEY_GONE_DETAIL,
  type ConsentTarget,
} from '../chat/doctor-deep.js';
import { doctorAppearance, type DoctorCheck } from '../chat/doctor.js';
import { KNOWN_PROVIDER_IDS, providerDisplayName } from '../engine/providers.js';
import { formatElapsed } from '../render/notation.js';
import { glyphOf, markWithWord } from '../render/tui/glyphs.js';
import { keyToken } from '../render/tui/legend.js';
import type { DoctorRemedy, DoctorSurface } from './doctor-port.js';
import {
  popupText,
  type PopupContent,
  type PopupHeading,
  type PopupListRow,
  type PopupOrigin,
} from './frame-model.js';
import { POPUP_FLOOR, popupGeometry, type PopupPlacement } from './geometry.js';
import { COPY_CONTROL } from './popup-copy.js';
import type { PopupControl, PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, scrubPopupText, wrapPopupText } from './popup-text.js';

/** The popup's steps: the checks (its first), a row's detail and the deep tier's confirmation line, both reached from the checks. */
export const DOCTOR_STEP = { checks: 0, detail: 1, line: 2 } as const;

/**
 * The rows of body a confirmation line may take where it is drawn, at the smallest terminal a popup is drawn on (80×24, with its rail): the most
 * it may take and still be on screen WHOLE, with no scrolling, before it can be answered (ADR-0148 §7: everything the answer covers has been
 * seen). The figure is the PAGE of that placement, read from the one geometry and never typed: a report is drawn in at most `listRows` rows, which
 * is every body row in the overlay and at most `INLINE_LIST_MAX_ROWS` in a block in the flow, so the same line that is whole in the
 * overlay is cut inline.
 */
function linePageRows(placement: PopupPlacement): number {
  const box = popupGeometry({
    columns: POPUP_FLOOR.columns,
    rows: POPUP_FLOOR.rows,
    kind: 'standard',
    placement,
    rail: true,
  });
  return box.fits ? Math.min(box.maxBodyRows, box.listRows) : 1;
}

const LINE_PAGE_ROWS: Readonly<Record<PopupPlacement, number>> = {
  overlay: linePageRows('overlay'),
  replace: linePageRows('replace'),
};

/** The smaller of the two pages: the figure for a line whose placement is not known. */
export const DOCTOR_LINE_ROWS: number = Math.min(LINE_PAGE_ROWS.overlay, LINE_PAGE_ROWS.replace);

/** The rows a confirmation line may take where the popup is drawn in `placement`; without one, the smaller page. */
export function doctorLineRows(placement?: PopupPlacement): number {
  return placement === undefined ? DOCTOR_LINE_ROWS : LINE_PAGE_ROWS[placement];
}

/** The confirmation line's own words (ADR-0148 §8), around the origins it names. */
export const CONSENT_LEAD = 'Sends one small request per provider, with its key, to:';
export const CONSENT_MCP = 'MCP servers are only reported, never contacted.';
/** What the line says when the destinations it would name do not fit the page whole: nothing is offered and nothing is sent. */
export const CONSENT_TOO_LONG = 'These destinations are too long to confirm, so nothing is sent.';
/** The same, said in a block in the flow (inline) when the alternate screen would hold the line whole: `here` is the block, not the product. */
export const CONSENT_TOO_LONG_HERE =
  'These destinations are too long to confirm here, so nothing is sent.';

/** The checks' heading: the dominant outcome, a failure before a warning, in the words of the text report (and their plural). */
export function doctorHeading(checks: readonly DoctorCheck[]): PopupHeading {
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  if (failures > 0) {
    const { role, word } = doctorAppearance('fail');
    return {
      status: role,
      statusWord: word,
      text: `doctor: ${String(failures)} ${failures === 1 ? 'check' : 'checks'} failed`,
    };
  }
  if (warnings > 0) {
    const { role, word } = doctorAppearance('warn');
    return {
      status: role,
      statusWord: word,
      text: `doctor: ${String(warnings)} ${warnings === 1 ? 'warning' : 'warnings'}`,
    };
  }
  const { role, word } = doctorAppearance('ok');
  return { status: role, statusWord: word, text: 'doctor: all checks passed' };
}

/** Where a row comes from: the quick tier, or the deep tier (labelled as such, with its age). */
export type DoctorTier = 'quick' | 'deep';

/** A row's id: its tier and the check's own id, so `Enter` finds the check it shows. */
export function doctorRowId(tier: DoctorTier, check: DoctorCheck): string {
  return `${tier}:${check.id}`;
}

function rowOf(tier: DoctorTier, check: DoctorCheck): PopupListRow {
  const { role, word } = doctorAppearance(check.status);
  return {
    id: doctorRowId(tier, check),
    label: scrubPopupText(check.label),
    detail: scrubPopupText(check.detail),
    status: role,
    statusWord: word,
  };
}

/** What the checks step shows: the quick tier's rows and, below a heading that says so and how old it is, the kept deep result's. */
export interface DoctorView {
  readonly quick: readonly DoctorCheck[];
  readonly deep?: { readonly checks: readonly DoctorCheck[]; readonly ageMs: number } | undefined;
}

/** The words of the deep rows' heading: they come from the deep check, this long ago. */
function deepSectionLabel(ageMs: number): string {
  return `Deep check, ${formatElapsed(ageMs)} ago`;
}

/** The checks step's content: a list of every row under the heading of what they add up to. */
export function checksContent(view: DoctorView): PopupContent {
  const rows: PopupListRow[] = view.quick.map((check) => rowOf('quick', check));
  const deep = view.deep;
  if (deep !== undefined) {
    rows.push({
      id: 'deep-section',
      label: deepSectionLabel(deep.ageMs),
      section: true,
      enabled: false,
    });
    rows.push(...deep.checks.map((check) => rowOf('deep', check)));
  }
  return {
    kind: 'list',
    heading: doctorHeading([...view.quick, ...(deep?.checks ?? [])]),
    rows,
  };
}

/** Whether the view has a row to show or to copy: a report of no rows says nothing, and is never headed as an all-clear. */
export function hasRows(view: DoctorView): boolean {
  return view.quick.length > 0 || (view.deep?.checks.length ?? 0) > 0;
}

/** The deep section's heading in the copied text: without the age, which is the moment the person looked and means nothing once pasted. */
const DEEP_COPY_HEADING = 'Deep check';

/**
 * The report as text, for `[c]`: the heading and the rows the popup shows, in the same scrubbed words, the glyphs in the form asked for. A view
 * with no row (the checks have not landed) is the empty text, never `doctor: all checks passed` over nothing. Every piece of untrusted text
 * passes the same last step the frame applies to a row ({@link popupText}: host glyphs blanked, line separators folded), so a label or a
 * detail with U+2028 cannot forge a line of its own in what is pasted. The deep section is headed without its age (it is read when the person
 * looks, and a pasted report is read later).
 */
export function doctorCopyText(view: DoctorView, ascii: boolean): string {
  if (!hasRows(view)) return '';
  const heading = doctorHeading([...view.quick, ...(view.deep?.checks ?? [])]);
  const mark = glyphOf(heading.status, ascii);
  const lines = [`${mark === heading.statusWord ? '' : `${mark} `}${popupText(heading.text)}`];
  const line = (check: DoctorCheck): string => {
    const { role, word } = doctorAppearance(check.status);
    return `  ${markWithWord(glyphOf(role, ascii), word)}  ${popupText(scrubPopupText(check.label))}  ${popupText(scrubPopupText(check.detail))}`;
  };
  lines.push(...view.quick.map(line));
  if (view.deep !== undefined) {
    lines.push(`  ${DEEP_COPY_HEADING}`);
    lines.push(...view.deep.checks.map(line));
  }
  return lines.join('\n');
}

/** What to do about the provider keys, on a surface: the Home has `/providers`; a chat has it only by going back to the Home (OD-2). */
export function providersRemedy(surface: DoctorSurface, offered: boolean): string {
  switch (surface) {
    case 'home':
      return offered
        ? `Press ${keyToken('Enter')} to open /providers and connect a key or review its source.`
        : 'Open /providers to connect a key or review its source.';
    case 'home-chat':
      return `Go back to the Home (${keyToken('Ctrl+C')} twice) and use /providers to connect a key or review its source.`;
    case 'standalone-chat':
      return 'Go back to the Home (start Relavium without arguments) and use /providers to connect a key or review its source.';
  }
}

/**
 * What to do about a provider whose request failed, on a surface. The row says only that the request failed, which a wrong key and a network
 * that did not answer both look like, so the sentence is true for both: check the network if the key is right, and otherwise review the key.
 * A provider that was not contacted at all (its endpoint changed, or its key could not be read) is a problem of the key's setup, and keeps
 * {@link providersRemedy}.
 */
export function failedProviderRemedy(
  check: DoctorCheck,
  surface: DoctorSurface,
  offered: boolean,
): string {
  if (check.detail === ENDPOINT_CHANGED_DETAIL || check.detail === KEY_GONE_DETAIL)
    return providersRemedy(surface, offered);
  const lead = 'If the key is right, check your network; otherwise';
  switch (surface) {
    case 'home':
      return offered
        ? `${lead} press ${keyToken('Enter')} to open /providers and review it.`
        : `${lead} review it with /providers.`;
    case 'home-chat':
      return `${lead} go back to the Home (${keyToken('Ctrl+C')} twice) and review it with /providers.`;
    case 'standalone-chat':
      return `${lead} go back to the Home (start Relavium without arguments) and review it with /providers.`;
  }
}

/** The remedy a row offers as one more step on this surface, or `undefined` when its remedy is words only (or the surface has none). */
export function remedyOf(
  tier: DoctorTier,
  check: DoctorCheck,
  surface: DoctorSurface,
): DoctorRemedy | undefined {
  if (surface !== 'home') return undefined;
  const providerRow = tier === 'deep' && check.id.startsWith('provider:');
  if (
    (check.id === PROVIDER_KEYS_ID && check.status === 'warn') ||
    (providerRow && check.status === 'fail')
  )
    return { kind: 'providers' };
  return undefined;
}

/** The id of the quick tier's provider-keys row. */
const PROVIDER_KEYS_ID = 'provider-keys';

/** The quick tier's provider-keys row from the presence of each key (never a value): `warn` at none. */
export function providerKeysCheck(
  present: ReadonlyMap<ProviderId, boolean>,
  unchecked: readonly ProviderId[],
): DoctorCheck {
  const total = KNOWN_PROVIDER_IDS.length;
  const usable = [...present.values()].filter(Boolean).length;
  const late =
    unchecked.length === 0
      ? ''
      : `; ${String(unchecked.length)} could not be checked (${unchecked.map(providerDisplayName).join(', ')})`;
  if (usable === 0)
    return {
      id: PROVIDER_KEYS_ID,
      label: 'provider keys',
      status: 'warn',
      detail: `no provider has a key${late}`,
    };
  return {
    id: PROVIDER_KEYS_ID,
    label: 'provider keys',
    status: 'ok',
    detail: `${String(usable)} of ${String(total)} providers have a key${late}`,
  };
}

/** What a row's detail says to do, by the check and the surface. Words only: no shell command is named inside the TUI (ADR-0122 §6). */
function whatToDo(
  tier: DoctorTier,
  check: DoctorCheck,
  surface: DoctorSurface,
  offered: boolean,
): readonly string[] {
  // The detail step has no `[r]` of its own: `Esc` goes back to the checks, where it checks again.
  const again = `${keyToken('Esc')} goes back to the checks, where ${keyToken('r')} checks again.`;
  if (tier === 'deep' && check.id.startsWith('provider:')) {
    if (check.status === 'ok') return ['The key worked: the request was answered.'];
    return [failedProviderRemedy(check, surface, offered)];
  }
  if (tier === 'deep')
    return [
      'Reported from this chat’s session: the server was not contacted to check it. Nothing to do here.',
    ];
  switch (check.id) {
    case 'keychain':
      return check.status === 'ok'
        ? ['Keys stored in the OS keychain can be read.']
        : [
            'Keys stored in the OS keychain cannot be read until it can be reached. This is a problem of the operating system: unlock the keychain or start its service.',
            again,
          ];
    case 'config':
      return check.status === 'ok'
        ? ['Every configuration file loads and is valid.']
        : ['Fix the file named above at the position it gives.', again];
    case PROVIDER_KEYS_ID:
      return check.status === 'ok'
        ? ['No key is shown here, and nothing was sent to check them.']
        : [providersRemedy(surface, offered)];
    case 'tools':
      return ['The capabilities a chat’s tools are given. Nothing to do here.'];
    default:
      return [];
  }
}

/** A row's detail step: what it is, the whole of its detail, and what to do (and, where a remedy exists on this surface, how to open it). */
export function detailContent(
  tier: DoctorTier,
  check: DoctorCheck,
  surface: DoctorSurface,
  options: { readonly deepAgeMs?: number | undefined; readonly offered: boolean },
): PopupContent {
  const { word } = doctorAppearance(check.status);
  const lines: string[] = [...wrapPopupText(`${scrubPopupText(check.label)}: ${word}`), ''];
  lines.push(...wrapPopupText(scrubPopupText(check.detail)));
  if (tier === 'deep' && options.deepAgeMs !== undefined)
    lines.push(...wrapPopupText(`From the ${deepSectionLabel(options.deepAgeMs).toLowerCase()}.`));
  const todo = whatToDo(tier, check, surface, options.offered);
  if (todo.length > 0) {
    lines.push('');
    for (const text of todo) lines.push(...wrapPopupText(text));
  }
  return { kind: 'report', lines };
}

/**
 * What a line that is too long for its page says, in words that are true where it is drawn. A shorter custom address always helps. A block in the
 * flow (the accessible mode, inline) is shorter than the overlay, so a line it cannot hold may be whole in the alternate screen: it is told, to a
 * person who chose inline, as a mode they can confirm in ("confirm them in full-screen mode", never "use the full-screen view", which is not
 * where they are), and `here` names the block. No shell command is named inside the TUI (ADR-0122 §6).
 */
function tooLongWords(
  lines: number,
  placement: PopupPlacement | undefined,
): { readonly what: string; readonly next: string } {
  const back = `${keyToken('Esc')} goes back.`;
  const fullScreen = placement === 'replace' && lines <= doctorLineRows('overlay');
  return fullScreen
    ? {
        what: CONSENT_TOO_LONG_HERE,
        next: `Shorten the custom addresses, or confirm them in full-screen mode, which has the rows to show them whole. ${back}`,
      }
    : {
        what: CONSENT_TOO_LONG,
        next: `Shorten the custom addresses to confirm them. ${back}`,
      };
}

/**
 * The confirmation line: the origins that will receive a key (each once), and what is never contacted; the providers left out and why. It is
 * offered only if it fits the page of `placement` (the overlay's, or the block in the flow's, which is shorter; without one, the smaller of the two).
 */
export function consentContent(
  targets: readonly ConsentTarget[],
  unknownOrigin: readonly ProviderId[],
  surface: DoctorSurface,
  placement?: PopupPlacement,
): PopupContent {
  if (targets.length === 0)
    return {
      kind: 'empty',
      what:
        unknownOrigin.length === 0
          ? 'No provider has a key, so the deep check has nothing to send.'
          : 'No provider’s key and endpoint could both be read, so nothing would be sent.',
      next: providersRemedy(surface, false),
    };
  const origins = [...new Set(targets.map((target) => target.origin))];
  const lines: string[] = [...wrapPopupText(CONSENT_LEAD)];
  for (const origin of origins)
    lines.push(...wrapPopupText(origin, POPUP_TEXT_COLUMNS - 2).map((part) => `  ${part}`));
  lines.push(...wrapPopupText(CONSENT_MCP));
  if (unknownOrigin.length > 0)
    lines.push(
      ...wrapPopupText(
        `Not contacted (its key or its endpoint could not be read): ${unknownOrigin.map(providerDisplayName).join(', ')}.`,
      ),
    );
  // A line that does not fit the page is never offered: the answer would cover lines that had to be scrolled to, or never were.
  if (lines.length > doctorLineRows(placement))
    return { kind: 'empty', ...tooLongWords(lines.length, placement) };
  return { kind: 'report', lines };
}

/** The loading words of each phase: the quick checks, the consent line being prepared, the deep requests. */
export const DOCTOR_LOADING = {
  quick: 'Checking your setup',
  keys: (done: number, total: number): string =>
    `Checking provider keys (${String(done)} of ${String(total)})`,
  line: 'Finding the providers that have a key',
  deep: 'Asking each provider with its key',
} as const;

/** The checks step when the quick tier could not run: the way out is `[r]` (or `[d]`, which does not need it). */
export function quickFailedContent(): PopupContent {
  return {
    kind: 'error',
    what: 'The checks could not run.',
    next: `${keyToken('r')} runs them again.`,
  };
}

// `[r]` runs the quick tier again (the step is listed only after a first run has landed or failed), and its verb is as short as the legend needs:
// at 80 columns the whole row `Enter details · [r] again · [d] deep check · [c] copy · Esc close` must fit the 66 columns of a popup, so that
// `[c] copy` is not the key that goes first where copying is most useful.
const QUICK_CONTROL: PopupControl = { key: 'r', verb: 'again' };
const DEEP_CONTROL: PopupControl = { key: 'd', verb: 'deep check' };

/**
 * The letters the checks step answers to: the quick check and the deep check always, and `[c] copy` only while the step shows rows. While it
 * loads, or says the checks could not run, there is no report to copy, and a copy of one would be a report of nothing.
 */
export function doctorChecksControls(rows: boolean): readonly PopupControl[] {
  return rows ? [QUICK_CONTROL, DEEP_CONTROL, COPY_CONTROL] : [QUICK_CONTROL, DEEP_CONTROL];
}

/** What `Enter` says on the detail of a row whose remedy this surface opens (the hand-off to the provider setup). */
export const DOCTOR_REMEDY_ENTER = 'open /providers';

/**
 * What `Enter` does on a row's detail, set with the detail itself (`PopupContext.setContent`): it opens the remedy only for a row that has
 * one on this surface, so a healthy row's detail names no `Enter` and its `Enter` answers nothing (MVP-11 unit 6 round 2, OB-1: a static
 * verb named `open /providers` on every detail).
 */
export function detailEnter(remedy: DoctorRemedy | undefined): string | false {
  return remedy === undefined ? false : DOCTOR_REMEDY_ENTER;
}

/**
 * The popup's spec: three steps, the later two reached from the first (`rail: 'path'`), opened on the line for a typed `/doctor --deep`. A
 * row's detail has no `Enter` of its own: the session sets it with each detail ({@link detailEnter}), from the row it shows.
 */
export function doctorSpec(origin: PopupOrigin, onLine: boolean): PopupSpec {
  return {
    id: 'doctor',
    title: '/doctor',
    origin,
    rail: 'path',
    initialStep: onLine ? DOCTOR_STEP.line : DOCTOR_STEP.checks,
    steps: [
      {
        name: 'Checks',
        content: { kind: 'loading', what: DOCTOR_LOADING.quick },
        enter: 'details',
        // The first content is the loading words: no rows yet, so no copy (the session sets the letters again with each result).
        controls: doctorChecksControls(false),
        // At 80 columns not every key fits: the deep check's consent and the re-check are kept longest, the arrows go first.
        legendKeep: ['d', 'r', 'Enter', 'c'],
      },
      {
        name: 'Detail',
        content: { kind: 'report', lines: [] },
        back: DOCTOR_STEP.checks,
      },
      {
        name: 'Deep check',
        content: { kind: 'loading', what: DOCTOR_LOADING.line },
        back: DOCTOR_STEP.checks,
        holds: 'chord',
        chord: { verb: 'send' },
      },
    ],
  };
}
