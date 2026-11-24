import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { HomeView } from './home-view.js';
import type { StripFocus } from './strip-focus.js';

describe('keyless Home view', () => {
  it.each([true, false])(
    'keeps the focused Continue session and prompt visible in a full strip (keyless=%s)',
    (keyless) => {
      const sessions = Array.from({ length: 8 }, (_, n) => ({
        sessionId: `session-${n}`,
        title: `Conversation ${n} ${'long title '.repeat(30)}`,
        workingDir: `/workspace/${'long directory/'.repeat(30)}`,
        agentSlug: 'chat',
        modelId: 'model',
        status: 'ended' as const,
        updatedAt: '2026-11-10T00:00:00.000Z',
        totalCostMicrocents: 0,
      }));
      const view = render(
        <HomeView
          snapshot={{
            attention: { gates: [], failedRuns: [] },
            recentSessions: sessions,
            recentRuns: [],
            recentAgents: [],
            unreadableRunIds: Array.from({ length: 50 }, (_, n) => `run-${n}`),
            isEmpty: false,
          }}
          editor={{ text: '', cursor: 0 }}
          nowMs={0}
          cols={80}
          rows={24}
          color={false}
          keyless={keyless}
          notice={'notice '.repeat(100)}
          stripFocus={{ kind: 'session', id: 'session-7' }}
        />,
      );
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('> Conversation 7');
      expect(frame).toContain('Enter resume');
      expect(frame).toContain('/workspace/');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      view.unmount();
    },
  );
  it('keeps setup and prompt visible at 80x24 by trimming management rows first', () => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: Array.from({ length: 50 }, (_, i) => `id-${i}`),
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        keyless
      />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Connect a provider');
    expect(frame).toContain('Enter to set up');
    expect(frame).not.toContain('↓ Continue');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    view.unmount();
  });
});

/** The Home's hint bar says what the keys do now (2.5.C S6): one sentence per state, drawn wide enough that none is cut. */
describe('the Home hint bar', () => {
  const session = {
    sessionId: 'session-1',
    title: 'Conversation',
    workingDir: '/workspace/project',
    agentSlug: 'chat',
    modelId: 'model',
    status: 'ended' as const,
    updatedAt: '2026-11-10T00:00:00.000Z',
    totalCostMicrocents: 0,
  };
  const frameOf = (over: {
    text?: string;
    sessions?: readonly (typeof session)[];
    stripFocus?: StripFocus;
    interruptArmed?: boolean;
  }): string => {
    const sessions = over.sessions ?? [];
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: sessions,
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: sessions.length === 0,
        }}
        editor={{ text: over.text ?? '', cursor: (over.text ?? '').length }}
        nowMs={0}
        cols={120}
        rows={30}
        color={false}
        stripFocus={over.stripFocus}
        interruptArmed={over.interruptArmed}
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('asks for the second Ctrl+C while the first is armed', () => {
    expect(frameOf({ interruptArmed: true })).toContain('Press Ctrl+C again to exit');
  });

  it('names the session picker keys while a session is being continued', () => {
    expect(
      frameOf({ sessions: [session], stripFocus: { kind: 'session', id: 'session-1' } }),
    ).toContain('↑/↓ select session · Enter resume · Esc return to prompt · Ctrl+C twice to exit');
  });

  it('says how to send once the person is composing', () => {
    expect(frameOf({ text: 'hello', sessions: [session] })).toContain(
      'Enter to start the chat · Ctrl+J newline · Ctrl+C twice to exit',
    );
  });

  it('offers Continue beside the palette at an empty prompt when there are sessions to continue, and does not when there are none', () => {
    expect(frameOf({ sessions: [session] })).toContain(
      '/ commands · ↓ Continue · type a message to chat · Ctrl+C twice to exit',
    );
    expect(frameOf({})).toContain(
      '/ for commands · type a message to start a chat · Ctrl+C twice to exit',
    );
  });
});

/** The keyless line promises `Enter` sets a provider up; while `Enter` does something else first, it must not be on screen. */
describe('the keyless line and the other things Enter does first', () => {
  const RUNNING_HOST: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: 'run-0001', cancelling: false },
    last: undefined,
  };
  const IDLE_HOST: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
  const PARKED = [{ runId: 'run-0002', kind: 'approval' as const, gates: 1 }];
  const frameOf = (over: {
    hostedRun?: RunHostSnapshot;
    parkedFocus?: string;
    keyless?: boolean;
  }): string => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={100}
        rows={30}
        color={false}
        keyless={over.keyless ?? true}
        hostedRun={over.hostedRun}
        parkedRuns={PARKED}
        stripFocus={
          over.parkedFocus === undefined ? undefined : { kind: 'run', id: over.parkedFocus }
        }
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('is shown with nothing else on offer for Enter', () => {
    expect(frameOf({})).toContain('Enter to set up');
  });

  it('is not shown while a live run is in the view: Enter shows the run first', () => {
    const frame = frameOf({ hostedRun: RUNNING_HOST });
    expect(frame).toContain('Enter shows it');
    expect(frame).not.toContain('Enter to set up');
    expect(frame).not.toContain('Connect a provider');
  });

  it('is not shown while a parked run is focused: Enter opens its gate first', () => {
    const frame = frameOf({ parkedFocus: 'run-0002' });
    expect(frame).toContain('Enter open the gate');
    expect(frame).not.toContain('Enter to set up');
  });

  it('is back once the run has ended and the focus has left the row', () => {
    expect(frameOf({ hostedRun: IDLE_HOST })).toContain('Enter to set up');
  });
});

/** The hint bar names what the focused parked row's Enter does, and promises a gate only when there is one. */
describe('the hint bar on a focused parked row', () => {
  const frameFor = (kind: 'approval' | 'none'): string => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        parkedRuns={[{ runId: 'run-0002', kind, gates: kind === 'none' ? 0 : 1 }]}
        stripFocus={{ kind: 'run', id: 'run-0002' }}
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('says the gate opens when the focused row has one', () => {
    const bar = frameFor('approval')
      .split('\n')
      .find((line) => line.includes('↑/↓ select'));
    expect(bar).toContain('Enter open the gate');
  });

  it('says what Enter does when the focused row has no gate to decide: it says why', () => {
    const frame = frameFor('none');
    const bar = frame.split('\n').find((line) => line.includes('↑/↓ select'));
    expect(bar).toContain('Enter says why');
    expect(bar).not.toContain('open the gate');
  });
});

/** The Attention row at the minimum width: the key it names is the part that must never be cut off. */
describe('the focused parked row at 80 columns', () => {
  const UUID = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';
  const rowLine = (kind: 'approval' | 'none' | 'several', cols: number): string => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: false,
        }}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={cols}
        rows={24}
        color={false}
        parkedRuns={[{ runId: UUID, kind, gates: kind === 'none' ? 0 : 3 }]}
        stripFocus={{ kind: 'run', id: UUID }}
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    const line = frame.split('\n').find((candidate) => candidate.includes('‖'));
    if (line === undefined) throw new Error(`no parked row in:\n${frame}`);
    return line;
  };

  it.each([
    ['none', 'Enter says why'],
    ['approval', 'Enter opens'],
    ['several', 'Enter opens'],
  ] as const)('a %s row with a 36-character id shows its whole cue (%s)', (kind, cue) => {
    const line = rowLine(kind, 80);
    expect(line.trimEnd().endsWith(cue), line).toBe(true);
    expect(line.length, 'inside the 80 columns').toBeLessThanOrEqual(80);
  });

  it('a row with no gate to decide is the one that overflows: its id gives up columns, the words and the key do not', () => {
    const line = rowLine('none', 80);
    expect(line, 'the id was shortened').toContain('…');
    expect(line, 'and still starts with the run it names').toContain(UUID.slice(0, 8));
    expect(line).toContain('parked, no gate to decide');
  });

  it('keeps the whole id when the row fits', () => {
    const line = rowLine('approval', 120);
    expect(line).toContain(UUID);
    expect(line).not.toContain('…');
  });
});
