/**
 * What a chat host hands the four report popups, and the one way a host opens one ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §6, §10; [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): `/agent`, `/cost` (and `/cost --release`),
 * `/workflows` and `/help`, and `/export`'s one-step confirmation (§10, OD-10: not a report, but opened the same way), opened ONLY in an
 * interactive chat (the chat the Home hosts and a stand-alone `relavium chat`). This module is the
 * EAGER half, split from the lazy half as `doctor-port.ts` is: types, the parse of a typed line, and a loader that brings the popups' code in
 * (`report-session.ts` and what it imports) only when the person first asks for a report, so a host never pays for it at start. What the four
 * reports and the `/doctor` popup share (the scrub and the wrap, the work starter, the copy, the phrases of a refused chord) is
 * `popup-text.ts`, `popup-work.ts`, `popup-copy.ts` and `chord-refusal.ts`, written once; `PopupWorkOwner` (`popup-work.ts`) is the owner they all
 * start work on.
 *
 * The hosts route and open, and hold no popup logic: the chat host (`chat-ink.tsx`) and the Home controller recognise the line
 * ({@link parseReportLine}) in the same place they open `/permissions` and `/doctor`, BEFORE the line is counted as a submit (so the popup
 * host's open gate never sees the command's own line as a turn in flight), and call {@link openReport}. A plain, `--json` or one-shot chat has
 * no port and prints exactly the text it printed before.
 */

import type { SessionCostRow } from '@relavium/db';
import type { UsageCoverage } from '@relavium/shared';

import type { BoundAgentView } from '../chat/bound-agent-view.js';
import type { Surface } from '../render/surface.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost } from './popup-host.js';
import type { PopupPortBase } from './popup-work.js';

/** Where a report is read: the chat the Home hosts, or a stand-alone `relavium chat` (the words of a remedy differ). */
export type ReportSurface = Extract<Surface, 'home-chat' | 'standalone-chat'>;

/** The session's spend as one read of the database and the live governor gave it. */
export interface CostReading {
  /** The authoritative realized total and its per-model rows, from ONE snapshot of `history.db`. */
  readonly totalCostMicrocents: number;
  readonly rows: readonly SessionCostRow[];
  readonly coverage: UsageCoverage | undefined;
  readonly models:
    | readonly { readonly model: string; readonly coverage: UsageCoverage }[]
    | undefined;
  /**
   * What the live governor holds against the cap, and whether its record is known not to be durable. Absent when the session has no cap (no
   * governor, so nothing is held in memory and nothing can be broken).
   */
  readonly governor:
    | { readonly microcents: number; readonly durabilityBroken: boolean }
    | undefined;
}

/** What a release cleared, in micro-cents: the durable record's amount and the live governor's (absent with no cap). */
export interface CostRelease {
  readonly durable: number;
  readonly live: number | undefined;
}

/**
 * What the `/cost` popup reads and does. **Both are called only in work the popup starts or at a confirmed answer**, never while the popup is
 * drawn: a read is a synchronous query of the database.
 */
export interface CostPort {
  /** Read the session's cost now. May throw (its code is what the popup says, never its message). */
  readonly read: () => CostReading | Promise<CostReading>;
  /**
   * Clear the held estimates: the durable record first and then the live governor, exactly as `/cost --release` does (`releaseHeldEstimates`).
   * Only called at the chord of the release step, and only when no turn is in flight.
   */
  readonly release: () => CostRelease;
}

/** What `/workflows` found in a chat: no project, the catalog (invalid entries kept), or why it could not list. */
export type WorkflowsReading =
  | { readonly kind: 'no-project' }
  | {
      readonly kind: 'catalog';
      readonly workflows: readonly CatalogEntry[];
      readonly agents: readonly CatalogEntry[];
    }
  /** The fault's own words (a catalog cap, a code), already as a transcript may carry them: never an absolute path. The popup scrubs it again. */
  | { readonly kind: 'fault'; readonly reason: string };

/** What the `/workflows` popup reads: the project's catalog, a synchronous disk scan done in the popup's own work. */
export interface WorkflowsPort {
  readonly read: () => WorkflowsReading | Promise<WorkflowsReading>;
}

/**
 * What the `/help` popup lists beside the keys: the commands of this surface's own palette come from the registry by the port's `surface`
 * (`commandsOf`), never from a copy. The port only says which keys the host's chat has, so a host that has fewer (a test) lists fewer.
 */
export interface HelpPort {
  readonly keys: readonly { readonly keys: string; readonly verb: string }[];
}

/** Where an in-chat `/export` would write, as the popup shows it before it asks. */
export interface SessionExportView {
  /** The file, relative to the project's root (`.relavium/workflows/<id>.relavium.yaml`): never absolute, never under `~`. */
  readonly target: string;
  /** Whether the write rewrites this session's own earlier export (the one overwrite `/export` makes); otherwise a new file. */
  readonly overwrites: boolean;
}

/**
 * What the in-chat `/export` popup reads and does ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, [MVP-11 OD-10](../../../../docs/roadmap/phases/mvp-11.md#72-decisions-od-1-to-od-23)): the scaffold is written only after the popup has
 * shown where it goes and the person answered `Ctrl+Y`. **Both are called only in work the popup starts or at a confirmed answer**, never while
 * the popup is drawn: they are a read of the session and the disk, and the session's own `/export` write.
 */
export interface SessionExportPort {
  /** Where an export would write NOW, worked out and not written (`prepareSessionExport`). May throw (no project, no free id, …). */
  readonly prepare: () => SessionExportView;
  /** Write the scaffold now: the session's own `/export` (`exportSessionToProject`), and the file it wrote, project-relative. May throw. */
  readonly commit: () => { readonly target: string };
  /** What a fault of either says, in the product's words (never the fault's own message). */
  readonly failure: (cause: unknown) => string;
  /** The review notice's sentence (`SESSION_EXPORT_REVIEW_NOTICE`'s): what the scaffold is, and what to review before committing it. */
  readonly review: string;
}

/** What a chat host hands the report popups. Built once per chat session; nothing in it is read until a popup runs. */
export interface ReportsPort extends PopupPortBase {
  readonly surface: ReportSurface;
  /** The agent this chat is bound to, made afresh on every call (the tier the session uses now). Absent ⇒ `/agent` is not a popup here. */
  readonly agent?: (() => BoundAgentView) | undefined;
  readonly cost?: CostPort | undefined;
  readonly workflows?: WorkflowsPort | undefined;
  readonly help?: HelpPort | undefined;
  /** `/export`'s confirmation popup (ADR-0148 §10). Absent ⇒ `/export` is dispatched and writes as it did (a plain, `--json` or one-shot chat). */
  readonly export?: SessionExportPort | undefined;
}

/** One report: the port member it needs, the command that names it, and whether the command takes `--release`. */
interface ReportDefinition {
  readonly kind: keyof ReportsPort;
  readonly command: string;
  readonly takesRelease: boolean;
}

/**
 * The reports, in one table: what a typed line is matched against ({@link parseReportLine}) and what a port has to hold for the report to be a
 * popup ({@link reportAvailable}: the member that is named like the kind). **The kinds are read from this table** ({@link ReportKind},
 * {@link ReportMembers}), so a fifth report is one row here, which names a member of the port (a row for a member that is not there does not
 * compile) and which the opener table of `report-session.ts` (typed over {@link ReportKind}) then requires; `report-port.test.ts` opens every row.
 */
export const REPORTS = [
  { kind: 'agent', command: '/agent', takesRelease: false },
  { kind: 'cost', command: '/cost', takesRelease: true },
  { kind: 'workflows', command: '/workflows', takesRelease: false },
  { kind: 'help', command: '/help', takesRelease: false },
  // Not a report but a one-step write that asks first (ADR-0148 §10, OD-10): routed, gated and opened exactly as the reports are, so it rides the
  // same one routing function and the same open adapter of every host, BEFORE the line is counted as a submit.
  { kind: 'export', command: '/export', takesRelease: false },
] as const satisfies readonly ReportDefinition[];

/** The report a typed line names: `/agent`, `/cost` (with `--release`), `/workflows`, `/help` or `/export`: the name of the member of the port that makes it a popup. */
export type ReportKind = (typeof REPORTS)[number]['kind'];

/** The members of a {@link ReportsPort} that come from the session's own line handler (the host adds the surface, the owner and the glyph form). */
export type ReportMembers = Pick<ReportsPort, ReportKind>;

export interface ParsedReportLine {
  readonly kind: ReportKind;
  /** `/cost --release`: the popup opens ON its confirmation step (ADR-0148 §6) and still needs the chord. Only a `/cost` line has it. */
  readonly release?: boolean;
}

/**
 * A typed report line the popups answer, white space around the words ignored: `/agent`, `/cost`, `/cost --release`, `/workflows` and `/help`.
 * **Any other argument form is `undefined`** and goes on to the command's own dispatch, which says what is wrong with it (`/agent now`,
 * `/cost --force`, `/help me`): the dispatch is the one place that judges an argument, and this parse never widens what it accepts.
 */
export function parseReportLine(line: string): ParsedReportLine | undefined {
  const [name, ...tokens] = line.trim().split(/\s+/u);
  const report = REPORTS.find((candidate) => candidate.command === name);
  if (report === undefined) return undefined;
  if (!report.takesRelease) return tokens.length === 0 ? { kind: report.kind } : undefined;
  return tokens.every((token) => token === '--release')
    ? { kind: report.kind, release: tokens.length > 0 }
    : undefined;
}

/** Whether `port` has what the report `kind` needs: a host that did not wire one prints its text, as before. */
export function reportAvailable(port: ReportsPort, kind: ReportKind): boolean {
  return port[kind] !== undefined;
}

/** What a host asks for when it opens a report. */
export interface ReportOpenRequest {
  readonly host: PopupHost;
  readonly port: ReportsPort;
  readonly line: ParsedReportLine;
  readonly origin: PopupOrigin;
  /**
   * Whether a turn, a submit, a `!` command or a native action is in flight in the host RIGHT NOW: the same facts its open gate reads
   * (`chatPopupRefusal`, `homePopupRefusal`), read again by the release step at the moment of the answer. The popup owns the keyboard, so none
   * can start behind it, but an answer is never taken on a state read earlier. Called synchronously and never throws.
   */
  readonly turnInFlight: () => boolean;
  /** How the work gives the event loop back before it reads (production: a macrotask); a test injects its own. */
  readonly yieldToLoop?: (() => Promise<void>) | undefined;
}

/**
 * Open the report popup `request.line` names over `request.host`, loading its code on first use. The promise settles once the popup is open or
 * refused (the host's gate says why in one notification); it rejects only when the code could not be loaded, which the caller reports as a
 * fault of its own, as `openDoctor`'s caller does.
 */
export async function openReport(request: ReportOpenRequest): Promise<void> {
  const { openReportPopup } = await import('./report-session.js');
  openReportPopup(request);
}
