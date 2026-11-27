/**
 * The Home's half of the flows that write (MVP-11 unit 6, 6.3; ADR-0148 §3, §6): the key that opens `/init`, `/import`, `/pricing` or the
 * `/workflows` popup's `[x]` export is NOT stamped as an answer on the Home's one key history (unit 6 round 1: a chord card's lockout runs from the moment
 * the card opened, so a flow whose first prompt is its `Ctrl+Y` card is armed by the card itself; a held key that never answers it is
 * `home-flow-popups.test.ts` and `native-prompt-framed.test.ts`); and what the flow resolves with is one notification on the Home's channel,
 * never the Home's notice or a transcript line.
 *
 * The controller is real; each flow is a spy that stays open, so the history is read at the moment the flow begins.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel } from '../../history/defined-model.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChordHistory } from './chord-guard.js';
import { createHomeController, type HomeControllerDeps } from './home-controller.js';
import type { DefinedPort } from '../../history/defined-model.js';
import type { HomePopupsPort } from '../../popups/home-port.js';

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const defined: DefinedPort = {
  read: () => ({
    model: buildDefinedModel({
      entries: [
        {
          slug: 'nightly',
          name: undefined,
          nodeCount: 1,
          path: 'nightly.relavium.yaml',
          valid: true,
        },
      ],
      pins: [],
    }),
    slugOf: (index) => (index === 0 ? 'nightly' : undefined),
    pathOf: (index) => (index === 0 ? 'nightly.relavium.yaml' : undefined),
  }),
};

type Opener = 'init' | 'import' | 'pricing' | 'export';

function mount(resolveWith: string | undefined = undefined) {
  let clock = 50_000;
  const history = createChordHistory();
  const announced: string[] = [];
  /** The flow, open until the test lets it resolve; when it began, the history's last resolution. */
  let release: () => void = () => undefined;
  const begun: number[] = [];
  const flow = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        begun.push(history.lastResolvedAt);
        release = () => resolve(resolveWith);
      }),
  );
  let workflowsPort: HomePopupsPort['workflows'];
  const deps: HomeControllerDeps = {
    now: () => clock,
    chordHistory: history,
    initializeProject: flow,
    importDefined: flow,
    pricing: flow,
    exportDefined: flow,
    defined,
    startChat: () => new Promise<never>(() => undefined),
    homeStore: { read: () => EMPTY },
    schedule: () => () => undefined,
    announce: (text) => {
      announced.push(text);
    },
    // The `/workflows` popup's request, kept: its `[x]` is the export's opener (MVP-11 unit 8).
    openHomePopup: (request) => {
      workflowsPort = request.port.workflows;
    },
    onExit: () => undefined,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  const open = async (opener: Opener): Promise<void> => {
    if (opener === 'export') {
      controller.handlePaste('/workflows');
      controller.handleKey('', ENTER);
      await flush();
      clock += 3000;
      workflowsPort?.export('nightly', 'detail');
      return;
    }
    controller.handlePaste(`/${opener}`);
    clock += 3000;
    controller.handleKey('', ENTER);
  };
  return {
    controller,
    history,
    announced,
    flow,
    begun,
    open,
    release: () => release(),
    now: () => clock,
  };
}

describe.each(['init', 'import', 'pricing', 'export'] as const)('%s', (opener) => {
  it('the key that opened the flow is never stamped as an answer: the flow’s own chord card is what locks a held key out', async () => {
    const m = mount();
    await m.open(opener);
    expect(m.flow).toHaveBeenCalledTimes(1);
    expect(m.begun, 'no answer on the history when the flow began').toEqual([
      Number.NEGATIVE_INFINITY,
    ]);
    expect(m.history.lastResolvedAt).toBe(Number.NEGATIVE_INFINITY);
  });

  it('what it resolves with is ONE notification; the Home’s notice stays as it was', async () => {
    const m = mount('Nothing was written.');
    await m.open(opener);
    m.release();
    await flush();
    expect(m.announced).toEqual(['Nothing was written.']);
    expect(m.controller.getSnapshot().notice).toBeUndefined();
    expect(m.controller.getSnapshot().screen).toBeUndefined();
  });

  it('a flow whose Done step said what happened leaves nothing to say', async () => {
    const m = mount(undefined);
    await m.open(opener);
    m.release();
    await flush();
    expect(m.announced).toEqual([]);
    expect(m.controller.getSnapshot().notice).toBeUndefined();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});
