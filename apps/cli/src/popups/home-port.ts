/**
 * What the Home hands its management popups, and the one way it opens one ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10 as amended 2026-11-27; [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4, OD-24): `/help`, `/agents` and `/workflows` on the
 * bare Home (`/permissions` is a settings popup over the project's port: `settings-port.ts`). This module is the EAGER half, split from the lazy one as
 * `report-port.ts` and `unreadable-run-port.ts` are: types and a loader that brings the popups' code in (`home-session.ts` and what it imports) only when the
 * person first opens one, so the Home's first paint never pays for it (`lazy-load.test.ts`).
 *
 * The controller builds the port from the dependencies it already holds and routes the word; it holds no popup logic. What a popup STARTS (a chat, a run,
 * an export, the Runs screen) it asks the controller for through the port, after closing itself: the controller owns the keyboard, the native flows and
 * the screens, and a popup never opens another surface by itself.
 *
 * A data module ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): types and one loader, nothing else.
 */

import type { RunStatus } from '@relavium/shared';

import type { DefinedPort } from '../history/defined-model.js';
import type { HomeAgentRequest } from '../home/agent-start.js';
import type { AgentsPort } from '../home/agents-port.js';
import type { WorkflowDetail } from '../home/workflow-detail.js';
import type { PinPort } from '../render/tui/tab-host-pin.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupHost, PopupOpenResult } from './popup-host.js';
import type { PopupPortBase } from './popup-work.js';

/** What `/help` lists beside the commands: the Home's keys, as the controller's table gives them (`HOME_KEYS`). */
export interface HomeHelpPort {
  readonly keys: readonly { readonly keys: string; readonly verb: string }[];
}

/** What `/agents` reads and starts. */
export interface HomeAgentsPort {
  /** The project's agent catalog, read now (the strip's own read). May throw a `CliError`: the popup says so. */
  readonly read: AgentsPort['read'];
  /**
   * `[c]` on a detail: start a chat bound to the agent whose file the detail showed. Called once the popup has closed. The request is the catalog's
   * own path and the definition the page was drawn from; the host reads the file once through the hardened read and refuses it unless it is still
   * that definition (`resolveHomeChatAgent`).
   */
  readonly chat: (request: HomeAgentRequest) => void;
}

/** One run of a workflow as the detail's last runs list it: its full id (a key, drawn as 8 characters), its status and when it was last written. */
export interface HomeWorkflowRun {
  readonly runId: string;
  readonly status: RunStatus;
  /** An ISO time: the run's `updated_at`, so a parked run's age is how long it has waited. */
  readonly at: string;
}

/** What `/workflows` reads and starts. */
export interface HomeWorkflowsPort {
  /** The catalogue and its pins and last runs, read now (the Defined tab's own read). May throw: the popup says so. */
  readonly read: DefinedPort['read'];
  /** The detail of the file at `path` (a catalog entry's own path). May throw a `CliError`. Absent ⇒ the detail says it cannot be read. */
  readonly describe?: ((path: string) => WorkflowDetail) | undefined;
  /** The last `limit` runs of the workflow `slug` recorded for this directory, newest first. May throw. Absent ⇒ no runs are listed. */
  readonly lastRuns?: ((slug: string, limit: number) => readonly HomeWorkflowRun[]) | undefined;
  /** The pin store behind `[p]`; absent ⇒ `[p]` says pinning is unavailable. */
  readonly pins?: PinPort | undefined;
  /** The monotonic-enough wall clock (epoch ms) the ages are told against. */
  readonly now: () => number;
  /**
   * `[r]`: start the `/run` popup at this workflow, from `/workflows`. Called once the popup has closed. The controller opens the flow (its picker
   * skipped once, its form, its `Ctrl+Y` confirmation and its single start are the flow's own); `Esc` at the first thing it asks, and a refusal,
   * bring `/workflows` back on the detail of `slug`; a run that starts opens the run view. `path` is the catalog's own path the row was listed
   * from, so the flow refuses a slug whose file is another one by then.
   */
  readonly run: (slug: string, path: string) => void;
  /** `[x]`: the export confirmation of this workflow, from `/workflows`; the popup is brought back on the detail when it ends. Called once the popup has closed. */
  readonly export: (slug: string) => void;
  /** `[h]` (no run) and `Enter` on a last run (that run's detail): leave for the Runs screen. Called once the popup has closed. */
  readonly openRuns: (runId?: string) => void;
}

/** What the Home hands its management popups. Built by the controller; nothing in it is read until a popup runs. */
export interface HomePopupsPort extends PopupPortBase {
  readonly help?: HomeHelpPort | undefined;
  readonly agents?: HomeAgentsPort | undefined;
  readonly workflows?: HomeWorkflowsPort | undefined;
}

/** The Home's management popups, in one table: the member of the port that makes each a popup. */
export type HomePopupKind = 'help' | 'agents' | 'workflows';

/** What a host asks for when it opens one. */
export interface HomePopupOpenRequest {
  readonly host: PopupHost;
  readonly port: HomePopupsPort;
  readonly kind: HomePopupKind;
  readonly origin: PopupOrigin;
  /**
   * Open `/workflows` ON the detail of this workflow (its slug), the highlight on it in the list behind: the popup the `/run` and the export it
   * handed the workflow to bring back when they end. A slug the catalogue no longer holds opens the list.
   */
  readonly at?: { readonly slug: string } | undefined;
  /** How the work gives the event loop back before it reads (production: a macrotask); a test injects its own. */
  readonly yieldToLoop?: (() => Promise<void>) | undefined;
}

/** Whether `port` has what the popup `kind` needs: a Home that wired none opens none, and the word says it is not available here. */
export function homePopupAvailable(port: HomePopupsPort, kind: HomePopupKind): boolean {
  return port[kind] !== undefined;
}

/**
 * Open the management popup `request.kind` names over `request.host`, loading its code on first use. The promise settles once the popup is open or
 * refused (the host's gate says why in one notification); it rejects only when the code could not be loaded, which the caller reports as a fault of
 * its own, as `openReport`'s caller does.
 */
export async function openHomePopup(request: HomePopupOpenRequest): Promise<PopupOpenResult> {
  const { openHomePopupNow } = await import('./home-session.js');
  return openHomePopupNow(request);
}
