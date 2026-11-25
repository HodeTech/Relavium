/**
 * What a chat host hands the four report popups, and the one way a host opens one ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §6, §10; [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): `/agent`, `/cost` (and `/cost --release`),
 * `/workflows` and `/help`, opened ONLY in an interactive chat (the chat the Home hosts and a stand-alone `relavium chat`). This module is the
 * EAGER half, the doctor's pattern (`doctor-port.ts`): types, the parse of a typed line, and a loader that brings the popups' code in
 * (`report-session.ts` and what it imports) only when the person first asks for a report, so a host never pays for it at start.
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
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost } from './popup-host.js';

/** Where a report is read: the chat the Home hosts, or a stand-alone `relavium chat` (the words of a remedy differ). */
export type ReportSurface = Extract<Surface, 'home-chat' | 'standalone-chat'>;

/**
 * The owner a report's work is entered on (`enter`: the session's database stays open until the read has settled) and a fault of it goes to
 * (`failure`), never to an unhandled rejection.
 */
export type ReportWorkOwner = Pick<InvocationWorkOwner, 'enter' | 'failure'>;

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

/** What a chat host hands the report popups. Built once per chat session; nothing in it is read until a popup runs. */
export interface ReportsPort {
  readonly surface: ReportSurface;
  /** The agent this chat is bound to, made afresh on every call (the tier the session uses now). Absent ⇒ `/agent` is not a popup here. */
  readonly agent?: (() => BoundAgentView) | undefined;
  readonly cost?: CostPort | undefined;
  readonly workflows?: WorkflowsPort | undefined;
  readonly help?: HelpPort | undefined;
  readonly workOwner?: ReportWorkOwner | undefined;
  /** The glyphs' plain forms are in force (colour is off, ADR-0145 §5). */
  readonly plainGlyphs?: boolean | undefined;
}

/** The members of a {@link ReportsPort} that come from the session's own line handler (the host adds the surface, the owner and the glyph form). */
export type ReportMembers = Pick<ReportsPort, 'agent' | 'cost' | 'workflows' | 'help'>;

/** The report a typed line names: `/agent`, `/cost` (with `--release`), `/workflows` or `/help`. */
export type ReportKind = 'agent' | 'cost' | 'workflows' | 'help';

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
  switch (name) {
    case '/agent':
    case '/workflows':
    case '/help':
      return tokens.length === 0
        ? { kind: name.slice(1) as 'agent' | 'workflows' | 'help' }
        : undefined;
    case '/cost':
      return tokens.every((token) => token === '--release')
        ? { kind: 'cost', release: tokens.length > 0 }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether `port` has what the report `kind` needs: a host that did not wire one prints its text, as before. */
export function reportAvailable(port: ReportsPort, kind: ReportKind): boolean {
  switch (kind) {
    case 'agent':
      return port.agent !== undefined;
    case 'cost':
      return port.cost !== undefined;
    case 'workflows':
      return port.workflows !== undefined;
    case 'help':
      return port.help !== undefined;
  }
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
