import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { renderFinalSummary } from './final-summary.js';
import { initialRunViewState, reduceRunEvent, type RunViewState } from './run-view-model.js';

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';

function reduceAll(events: readonly RunEvent[]): RunViewState {
  return events.reduce(reduceRunEvent, initialRunViewState());
}

describe('renderFinalSummary', () => {
  it('summarizes a completed run with cost, duration, tokens, and per-node status', () => {
    const state = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        output: null,
        tokensUsed: { input: 10, output: 5 },
        durationMs: 420,
      },
      {
        type: 'run:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        outputs: {},
        totalTokensUsed: { input: 10, output: 5 },
        totalCostMicrocents: 5_000_000,
        durationMs: 1234,
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('run completed');
    expect(out).toContain('$0.0500');
    expect(out).toContain('1.2s');
    expect(out).toContain('↑10 ↓5');
    expect(out).toContain('✓ completed a (420ms)');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('summarizes a failed run with the error code and message', () => {
    const state = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:failed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        error: { code: 'provider_unavailable', message: 'boom', retryable: false },
      },
      {
        type: 'run:failed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        error: { code: 'provider_unavailable', message: 'upstream down', retryable: false },
        partialOutputs: {},
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('run failed (provider_unavailable)');
    expect(out).toContain('upstream down');
    expect(out).toContain('✗ failed    a — provider_unavailable');
  });

  it('summarizes a paused run with the gate ids', () => {
    const state = reduceAll([
      {
        type: 'run:paused',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        pendingGateCount: 1,
        gateIds: ['approve-1'],
      },
    ]);
    expect(renderFinalSummary(state)).toContain('run paused at gate approve-1');
  });

  it('shows the run id with the command that continues from the outcome (MVP-A2)', () => {
    const started: RunEvent = {
      type: 'run:started',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    };
    const completed = reduceAll([
      started,
      {
        type: 'run:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        outputs: {},
        durationMs: 10,
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
      },
    ]);
    expect(renderFinalSummary(completed)).toContain(
      `  run id ${RUN} — replay with \`relavium logs ${RUN}\``,
    );
    const paused = reduceAll([
      started,
      {
        type: 'human_gate:paused',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'approve',
        gateId: 'approve-1',
        gateType: 'approval',
        message: 'approve?',
      },
      {
        type: 'run:paused',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        pendingGateCount: 1,
        gateIds: ['approve-1'],
      },
    ]);
    expect(renderFinalSummary(paused)).toContain(
      `  run id ${RUN} — resume with \`relavium gate ${RUN}\``,
    );
    // Before any event the summary has no id to offer.
    expect(renderFinalSummary(reduceAll([]))).not.toContain('run id');
  });

  describe('a run id the shell would not take as one word is never put in a copyable command (PR #102 review)', () => {
    const HOSTILE = [
      ['a space', 'run-1 x'],
      ['a semicolon', 'run-1;touch x'],
      ['a backtick', 'run-1`touch x`'],
      ['a command substitution', 'run-1$(touch x)'],
      ['a newline', 'run-1\ntouch x'],
      ['a leading dash', '-rf'],
    ] as const;
    const stateFor = (runId: string, tail: readonly Partial<RunEvent>[]): RunViewState =>
      reduceAll([
        {
          type: 'run:started',
          runId,
          timestamp: TS,
          sequenceNumber: 1,
          workflowId: '00000000-0000-4000-8000-000000000001',
          inputs: {},
          executionMode: 'local',
        },
        ...tail.map(
          (event, index): RunEvent =>
            RunEventSchema.parse({
              runId,
              timestamp: TS,
              sequenceNumber: index + 2,
              ...event,
            }),
        ),
      ]);
    /** Every `relavium` command text between backticks in the lines the continuation wrote. */
    const commandsIn = (out: string): string[] =>
      out
        .split('\n')
        .filter((line) => line.startsWith('  run id'))
        .flatMap((line) => [...line.matchAll(/`([^`]*)`/gu)].map((match) => match[1] ?? ''));

    it.each(HOSTILE)(
      'writes no command that carries an id with %s, and still names the id in prose',
      (_name, id) => {
        const humanPaused = stateFor(id, [
          {
            type: 'human_gate:paused',
            nodeId: 'approve',
            gateId: 'approve-1',
            gateType: 'approval',
            message: 'approve?',
          },
          { type: 'run:paused', pendingGateCount: 1, gateIds: ['approve-1'] },
        ]);
        const ended = stateFor(id, [
          {
            type: 'run:completed',
            outputs: {},
            durationMs: 1,
            totalTokensUsed: { input: 0, output: 0 },
            totalCostMicrocents: 0,
          },
        ]);
        const mediaOnly = stateFor(id, [
          {
            type: 'run:paused',
            pendingGateCount: 0,
            gateIds: [],
            pendingMediaJobNodeIds: ['render'],
          },
        ]);
        const out = [ended, humanPaused, mediaOnly].map(renderFinalSummary).join('');
        // The commands that were written are the bare ones: no id, so nothing a shell could split.
        expect(commandsIn(out).sort()).toEqual([
          'relavium gate',
          'relavium logs',
          'relavium status',
        ]);
        // No line carries the raw tail of the hostile id after a command word, and no control character survives.
        expect(out).not.toMatch(/relavium (?:logs|status|gate) [^`]*(?:touch|-rf)/u);
        // eslint-disable-next-line no-control-regex -- the assertion is that no control survives
        expect(out.replaceAll('\n', '')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
        // The id is still told, in prose, with no backtick a person could copy as a command.
        const proseLines = out.split('\n').filter((line) => line.startsWith('  run id'));
        expect(proseLines.length).toBeGreaterThan(0);
        for (const line of proseLines) expect(line).not.toMatch(/run id [^—]*`/u);
      },
    );

    it('keeps the exact commands for ids the shell takes as one word, a UUID among them', () => {
      for (const id of ['run-1', '3f2b8e9c-6a1d-4f7e-9b0a-1c2d3e4f5a6b', 'run_1.2:3']) {
        const ended = stateFor(id, [
          {
            type: 'run:completed',
            outputs: {},
            durationMs: 1,
            totalTokensUsed: { input: 0, output: 0 },
            totalCostMicrocents: 0,
          },
        ]);
        expect(renderFinalSummary(ended)).toContain(
          `  run id ${id} — replay with \`relavium logs ${id}\``,
        );
      }
    });
  });

  it('points each outcome at the command that accepts it: logs, gate, budget resume or status (MVP-A2)', () => {
    const started: RunEvent = {
      type: 'run:started',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    };
    const budgetPause: RunEvent = {
      type: 'budget:paused',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      nodeId: 'writer',
      spentMicrocents: 11,
      limitMicrocents: 10,
      gateId: 'budget-1',
    };
    const humanPause = (sequenceNumber: number, gateId: string, nodeId = 'approve'): RunEvent => ({
      type: 'human_gate:paused',
      runId: RUN,
      timestamp: TS,
      sequenceNumber,
      nodeId,
      gateId,
      gateType: 'approval',
      message: 'approve?',
    });
    const paused = (sequenceNumber: number, gateIds: string[]): RunEvent => ({
      type: 'run:paused',
      runId: RUN,
      timestamp: TS,
      sequenceNumber,
      pendingGateCount: gateIds.length,
      gateIds,
      ...(gateIds.length === 0 ? { pendingMediaJobNodeIds: ['render'] } : {}),
    });
    const logs = `  run id ${RUN} — replay with \`relavium logs ${RUN}\``;
    const gate = `  run id ${RUN} — resume with \`relavium gate ${RUN}\``;
    const budget = `  run id ${RUN} — approve or abort the budget gate with \`relavium budget resume ${RUN} --gate budget-1\` (\`relavium status ${RUN}\` shows the amount)`;
    const status = `  run id ${RUN} — \`relavium status ${RUN}\` shows each gate it is parked on and the command that continues it`;
    const linesOf = (events: readonly RunEvent[]): string[] =>
      renderFinalSummary(reduceAll(events))
        .split('\n')
        .filter((line) => line.startsWith('  run id'));

    const failed: RunEvent = {
      type: 'run:failed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      error: { code: 'internal', message: 'boom', retryable: false },
      partialOutputs: {},
    };
    const cancelled: RunEvent = {
      type: 'run:cancelled',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
    };
    expect(linesOf([started, failed])).toEqual([logs]);
    expect(linesOf([started, cancelled])).toEqual([logs]);
    expect(linesOf([started])).toEqual([logs]); // no terminal yet: "run ended"
    // A budget gate is resumed by `budget resume`, which `gate` refuses.
    expect(linesOf([started, budgetPause, paused(3, ['budget-1'])])).toEqual([budget]);
    // A human gate beside it still names `gate` first.
    expect(
      linesOf([
        started,
        budgetPause,
        humanPause(3, 'approve-1'),
        paused(4, ['approve-1', 'budget-1']),
      ]),
    ).toEqual([gate, budget]);
    // A budget gate's own `human_gate:paused` companion is its prompt, not a human gate.
    expect(
      linesOf([started, budgetPause, humanPause(3, 'budget-1', 'writer'), paused(4, ['budget-1'])]),
    ).toEqual([budget]);
    // A run parked on a media job only has no gate to resume.
    expect(linesOf([started, paused(2, [])])).toEqual([
      `  run id ${RUN} — check it with \`relavium status ${RUN}\``,
    ]);
    // A resumed stream (`relavium gate`) carries no run:started; the id comes from its first event.
    const resumed: RunEvent = {
      type: 'human_gate:resumed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 7,
      nodeId: 'approve',
      gateId: 'approve-1',
      decision: 'approved',
      decidedBy: 'cli',
    };
    // A gate the resumed stream announces is classified as on a fresh run…
    expect(linesOf([resumed, humanPause(8, 'approve-2'), paused(9, ['approve-2'])])).toEqual([
      gate,
    ]);
    // …but a resumed engine re-parks on the gates it restored from its checkpoint WITHOUT announcing them, and such a
    // gate may be a budget gate, which `gate` declines: only `status`, which reads the whole log, can name its command.
    expect(linesOf([resumed, paused(8, ['budget-1'])])).toEqual([status]);
    expect(
      linesOf([resumed, humanPause(8, 'approve-2'), paused(9, ['approve-2', 'budget-1'])]),
    ).toEqual([gate, status]);
    expect(
      linesOf([
        resumed,
        { ...budgetPause, sequenceNumber: 8 },
        paused(9, ['budget-1', 'approve-2']),
      ]),
    ).toEqual([budget, status]);
  });

  it('is plain text — no ANSI escape codes (scrollback-safe / --no-color)', () => {
    const state = reduceAll([
      { type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 1 },
    ]);
    expect(renderFinalSummary(state).includes(String.fromCharCode(27))).toBe(false);
  });

  it('produces a meaningful summary when no terminal event was received (SIGINT / early exit)', () => {
    const out = renderFinalSummary(initialRunViewState()); // summary undefined → default headline
    expect(out).toContain('run ended');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('lists produced media deliverables (handle + node attribution) under a section (2.S)', () => {
    const handle = `media://sha256-${'a'.repeat(64)}`;
    const state = reduceAll([
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'painter',
        output: {
          content: [
            {
              type: 'media',
              mimeType: 'image/png',
              source: { kind: 'handle', ref: handle },
              byteLength: 9,
            },
          ],
        },
        tokensUsed: { input: 0, output: 0 },
        durationMs: 5,
      },
      {
        type: 'run:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        outputs: {},
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
        durationMs: 9,
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('produced media:');
    expect(out).toContain(`◆ image/png ${handle} (painter)`); // handle + node attribution, never bytes
  });

  it('omits the produced-media section when a run emitted none', () => {
    const state = reduceAll([
      { type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 1 },
    ]);
    expect(renderFinalSummary(state)).not.toContain('produced media');
  });

  it('projects every untrusted terminal value safely while retaining readable final-summary content (#57)', () => {
    const attack = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';
    const nodeId = `node visible${attack}\nforged node row`;
    const state: RunViewState = {
      ...initialRunViewState(),
      nodeOrder: [nodeId],
      nodes: {
        [nodeId]: {
          nodeId,
          status: 'failed',
          errorCode: `node error visible${attack}\nforged node suffix`,
        },
      },
      producedMedia: [
        {
          nodeId: `media node visible${attack}\nforged media node`,
          mimeType: `image/png visible${attack}\nforged mime`,
          handle: `media://visible${attack}\nforged handle`,
        },
      ],
      summary: {
        outcome: 'failed',
        errorCode: `run error visible${attack}\nforged run suffix`,
        errorMessage: `failure visible${attack}\nsecond failure line`,
      },
    };
    const paused: RunViewState = {
      ...state,
      summary: {
        outcome: 'paused',
        pausedGateIds: [`gate visible${attack}\nforged gate`],
      },
    };

    const output = `${renderFinalSummary(state)}${renderFinalSummary(paused)}`;
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('run error visible');
    expect(output).toContain('failure visible');
    expect(output).toContain('second failure line'); // summary errors stay readable after a newline collapses
    expect(output).toContain('node visible');
    expect(output).toContain('node error visible');
    expect(output).toContain('image/png visible');
    expect(output).toContain('media://visible');
    expect(output).toContain('media node visible');
    expect(output).toContain('gate visible');
  });

  it('keeps an untrusted failure message on its one summary row (it cannot forge a node status)', () => {
    const state: RunViewState = {
      ...initialRunViewState(),
      summary: {
        outcome: 'failed',
        errorMessage: 'provider failed\n  ✓ deploy completed',
      },
    };

    const lines = renderFinalSummary(state).trimEnd().split('\n');
    expect(lines).toHaveLength(2); // headline + one labeled error row; no forged third status row
    expect(lines[1]).toContain('provider failed');
    expect(lines[1]).toContain('✓ deploy completed');
    expect(lines).not.toContain('  ✓ deploy completed');
  });

  it('masks a secret shape in the failure message before it reaches the terminal', () => {
    // A PR #96 review: the summary row collapsed separators but did not mask, unlike every other
    // untrusted diagnostic sink.
    const key = `sk-${'Qz7'.repeat(8)}`;
    const state: RunViewState = {
      ...initialRunViewState(),
      summary: {
        outcome: 'failed',
        errorMessage: `provider rejected Authorization: Bearer ${key}`,
      },
    };

    const output = renderFinalSummary(state);
    expect(output).not.toContain(key);
    expect(output).toContain('provider rejected');
    expect(output).toContain('[REDACTED]');
  });
});
