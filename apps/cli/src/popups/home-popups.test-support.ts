/**
 * Test support for the Home's management popups ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4: `/help`, `/agents`,
 * `/workflows`): a popup host on a manual clock with its frame "on screen" and a popup opened on it through the opener table, ports over fakes whose
 * every call is recorded, and the words of the step on screen. Nothing here reaches a database, a disk, a keychain or a network.
 */

import type { AgentDefinition } from '@relavium/core';
import type { RunStatus } from '@relavium/shared';
import { vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../history/agents-model.js';
import {
  buildDefinedModel,
  type DefinedOtherPin,
  type DefinedPin,
  type DefinedRead,
} from '../history/defined-model.js';
import type { AgentsRead } from '../home/agents-port.js';
import type { WorkflowDetail } from '../home/workflow-detail.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import type { PinPort } from '../render/tui/tab-host-pin.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import { manualClock } from './doctor.test-support.js';
import type { PopupContent } from './frame-model.js';
import type {
  HomeAgentsPort,
  HomePopupKind,
  WorkflowsAt,
  HomePopupsPort,
  HomeWorkflowRun,
  HomeWorkflowsPort,
} from './home-port.js';
import { openHomePopupNow } from './home-session.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost, type PopupOpenResult } from './popup-host.js';
import type { PopupWorkOwner } from './popup-work.js';
import { currentStep, visibleRows, type PopupKey } from './popup-reducer.js';

export { manualClock, settleWork } from './doctor.test-support.js';

/** A work owner that runs what it is given and records every fault it is told of. */
export const recordingOwner = (failures: unknown[]): PopupWorkOwner => ({
  enter: (operation) => operation(),
  failure: (cause) => {
    failures.push(cause);
  },
});

export const ENTER: PopupKey = { return: true };
export const ESC: PopupKey = { escape: true };
export const DOWN: PopupKey = { downArrow: true };
export const UP: PopupKey = { upArrow: true };
export const CTRL_C: PopupKey = { ctrl: true };

/** A valid workflow entry of the catalogue. */
export const workflowEntry = (slug: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  nodeCount: 3,
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  ...over,
});

/** A workflow file that did not parse: no node count, and the catalogue's reason. */
export const invalidWorkflowEntry = (slug: string, error: string): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: false,
  error,
});

/** A catalogue read over `entries` and `pins`, with the latest run of some workflows (`lastRuns`, and when: `lastRunTimes`). */
export function definedRead(
  entries: readonly CatalogEntry[],
  options: {
    readonly pins?: readonly DefinedPin[];
    /** Workflow pins of OTHER projects: rows the popup lists and can only unpin. */
    readonly otherPins?: readonly DefinedOtherPin[];
    readonly lastRuns?: ReadonlyMap<string, RunStatus>;
    readonly lastRunTimes?: ReadonlyMap<string, string>;
  } = {},
): DefinedRead {
  const model = buildDefinedModel({
    entries,
    pins: options.pins ?? [],
    ...(options.otherPins === undefined ? {} : { otherPins: options.otherPins }),
    ...(options.lastRuns === undefined ? {} : { lastRuns: options.lastRuns }),
    ...(options.lastRunTimes === undefined ? {} : { lastRunTimes: options.lastRunTimes }),
  });
  return {
    model,
    slugOf: (index) => entries[index]?.slug,
    pathOf: (index) => entries[index]?.path,
  };
}

/** A workflow's detail as the catalog port would give it. */
export const detailOf = (over: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  description: 'Drafts release notes for a version.',
  inputs: [{ name: 'version', type: 'string', required: true }],
  inputsMore: 0,
  nodes: [{ id: 'start' }, { id: 'draft' }, { id: 'approve', note: 'approval, 10 min' }],
  nodesMore: 0,
  ...over,
});

/** A pin port over a set of pinned slugs, every call recorded; `full` refuses a pin as the store does at its cap. */
export function fakePins(initial: readonly string[] = [], full = false) {
  const pinned = new Set(initial);
  const calls: string[] = [];
  const port: PinPort = {
    pinWorkflow: (slug) => {
      calls.push(`pin ${slug}`);
      if (full) return 'full';
      pinned.add(slug);
      return 'pinned';
    },
    unpinWorkflow: (slug) => {
      calls.push(`unpin ${slug}`);
      return pinned.delete(slug);
    },
    pinRun: () => 'pinned',
    unpinRun: () => true,
    unpinRow: (rowid) => {
      calls.push(`unpin row ${String(rowid)}`);
      // The rows of a read are numbered from 1 in the order the pins were made, as `fakeWorkflows` lists them.
      const ref = [...pinned][rowid - 1];
      return ref === undefined ? false : pinned.delete(ref);
    },
  };
  return { port, pinned, calls };
}

/** What a rig of the `/workflows` popup holds: the fakes behind its port and what the popup asked of its host. */
export interface WorkflowsFakes {
  readonly entries: CatalogEntry[];
  readonly pins: ReturnType<typeof fakePins>;
  readonly runs: Map<string, HomeWorkflowRun[]>;
  /** What the popup asked its host for, in order: `run slug path`, `export slug`, `runs`, `runs <id>`. */
  readonly asked: string[];
  readonly read: ReturnType<typeof vi.fn<() => DefinedRead>>;
  readonly describe: ReturnType<typeof vi.fn<(path: string) => WorkflowDetail>>;
  readonly lastRuns: ReturnType<
    typeof vi.fn<(slug: string, limit: number) => readonly HomeWorkflowRun[]>
  >;
  readonly port: HomeWorkflowsPort;
  /** The wall clock the ages are told against (epoch ms). */
  now: number;
}

/** A `/workflows` port over fakes: the catalogue's entries (the pins follow `pins`), each workflow's runs, and the host's requests recorded. */
export function fakeWorkflows(
  entries: readonly CatalogEntry[] = [workflowEntry('backup-db'), workflowEntry('release-notes')],
  options: {
    readonly now?: number;
    readonly describe?: (path: string) => WorkflowDetail;
    readonly pinned?: readonly string[];
    readonly full?: boolean;
    /** Workflow pins of other projects, by their ref and their project's root. */
    readonly otherPins?: readonly { readonly ref: string; readonly projectRoot: string }[];
  } = {},
): WorkflowsFakes {
  const list = [...entries];
  const pins = fakePins(options.pinned ?? [], options.full === true);
  const runs = new Map<string, HomeWorkflowRun[]>();
  const asked: string[] = [];
  const fakes = { now: options.now ?? Date.parse('2026-11-27T12:00:00Z') };
  const read = vi.fn((): DefinedRead => {
    const pinList: DefinedPin[] = [...pins.pinned].map((ref, rowid) => ({
      kind: 'workflow',
      ref,
      rowid: rowid + 1,
      oversized: false,
    }));
    const lastRuns = new Map<string, RunStatus>();
    const times = new Map<string, string>();
    for (const [slug, items] of runs) {
      const latest = items[0];
      if (latest === undefined) continue;
      lastRuns.set(slug, latest.status);
      times.set(slug, latest.at);
    }
    // A snapshot, as the real read's: the entries are held by the read, so a file added later is not seen through an older read.
    const otherPins: DefinedOtherPin[] = (options.otherPins ?? []).map((pin, at) => ({
      kind: 'workflow',
      ref: pin.ref,
      rowid: 1000 + at,
      oversized: false,
      projectRoot: pin.projectRoot,
    }));
    return definedRead([...list], { pins: pinList, otherPins, lastRuns, lastRunTimes: times });
  });
  const describe = vi.fn(options.describe ?? ((): WorkflowDetail => detailOf()));
  const lastRuns = vi.fn((slug: string, limit: number): readonly HomeWorkflowRun[] =>
    (runs.get(slug) ?? []).slice(0, limit),
  );
  const port: HomeWorkflowsPort = {
    read,
    describe,
    lastRuns,
    pins: pins.port,
    now: () => fakes.now,
    run: (slug, path, from, row) => {
      asked.push(`run ${slug} ${path} from ${from}${row === undefined ? '' : ` at ${row}`}`);
    },
    export: (slug, from, row) => {
      asked.push(`export ${slug} from ${from}${row === undefined ? '' : ` at ${row}`}`);
    },
    openRuns: (runId, status) => {
      asked.push(runId === undefined ? 'runs' : `runs ${runId} ${status ?? '?'}`);
    },
  };
  return {
    entries: list,
    pins,
    runs,
    asked,
    read,
    describe,
    lastRuns,
    port,
    get now() {
      return fakes.now;
    },
    set now(value: number) {
      fakes.now = value;
    },
  };
}

/** An agent definition: the fields the detail reads. */
export const agentDefinition = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'commit-reviewer',
  name: 'Commit reviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  system_prompt: 'You review git commits of the repository.',
  tools: ['read_file', 'run_command'],
  temperature: 0.2,
  ...over,
});

/** An agents read over items (a valid one with its definition, an invalid one with its reason). */
export function agentsRead(items: readonly AgentsModelItem[]): AgentsRead {
  const model = buildAgentsModel(items);
  return {
    model,
    slugOf: (index) => items[index]?.entry.slug,
    pathOf: (index) => items[index]?.entry.path,
    definitionOf: (index) => items[index]?.agent as AgentDefinition | undefined,
  };
}

/** A valid agent item. */
export const readyAgent = (slug: string, over: Partial<AgentDefinition> = {}): AgentsModelItem => {
  const agent = agentDefinition({ id: slug, ...over });
  return {
    entry: {
      slug,
      name: agent.name,
      path: `.relavium/agents/${slug}.agent.yaml`,
      valid: true,
    },
    agent,
  };
};

/** An invalid agent item with the catalog's reason. */
export const brokenAgent = (slug: string, reason = 'agent.model: required'): AgentsModelItem => ({
  entry: {
    slug,
    name: undefined,
    path: `.relavium/agents/${slug}.agent.yaml`,
    valid: false,
    error: reason,
  },
  agent: undefined,
});

/** An agents port over `items`, every read and every `chat` request recorded. */
export function fakeAgents(items: readonly AgentsModelItem[] = [readyAgent('commit-reviewer')]) {
  const chats: { readonly path: string; readonly listed: AgentDefinition }[] = [];
  const read = vi.fn((): AgentsRead => agentsRead(items));
  const port: HomeAgentsPort = {
    read,
    chat: (request) => {
      chats.push(request);
    },
  };
  return { port, read, chats };
}

/** A popup host on a manual clock with its frame "on screen", and a Home popup opened on it through the opener table. */
export function homeRig() {
  const clock = manualClock();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history: createChordHistory(),
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 18);
  host.bindInnerWidth(() => 66);
  const open = (
    kind: HomePopupKind,
    port: Partial<HomePopupsPort>,
    at?: WorkflowsAt,
  ): PopupOpenResult =>
    openHomePopupNow({
      host,
      port,
      kind,
      origin: 'home',
      at,
      yieldToLoop: () => Promise.resolve(),
    });
  const content = (step?: number): PopupContent => {
    const frame = host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup is open');
    const state = frame.steps[step ?? frame.stepIndex];
    if (state === undefined) throw new Error('no such step');
    return state.content;
  };
  /** The words of the step on screen, whatever its kind: rows as `label detail tail`, a report's lines, a state's words. */
  const words = (): string => {
    const shown = content();
    switch (shown.kind) {
      case 'list':
        return shown.rows
          .map((row) =>
            [row.statusWord, row.label, row.detail, row.tail?.words, row.tail?.after]
              .filter((part) => part !== undefined)
              .join(' '),
          )
          .join('\n');
      case 'report':
        return shown.lines.join('\n');
      case 'loading':
        return shown.what;
      case 'empty':
      case 'error':
        return `${shown.what}\n${shown.next}`;
      case 'form':
        return [shown.summary ?? '', shown.warning ?? ''].join('\n');
      case 'done':
        return [shown.message, ...shown.lines].join('\n');
    }
  };
  return {
    host,
    clock,
    notifications,
    open,
    content,
    words,
    /** The popup has appeared and its settle time has passed: an answer may count. */
    settle: (): void => {
      host.shown(host.getSnapshot());
      clock.advance(700);
    },
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    isOpen: (): boolean => host.getSnapshot().open,
    /** The id of the highlighted row of the step on screen. */
    highlighted: (): string | undefined => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return undefined;
      const { state } = currentStep(frame);
      return visibleRows(state)[state.selected]?.id;
    },
    /** The letters the step on screen answers to now. */
    controls: (): readonly string[] => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return [];
      const { spec, state } = currentStep(frame);
      return (state.controls ?? spec.controls ?? []).map((control) => control.key);
    },
    notice: (): string | undefined => notifications.getSnapshot().current?.text,
  };
}

export type HomeRig = ReturnType<typeof homeRig>;
