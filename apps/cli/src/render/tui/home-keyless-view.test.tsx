import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { withoutStyles } from './harness-util.js';
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
    expect(frame).toContain('No provider key yet · Enter connect · /providers');
    expect(frame).toContain('Enter connect a provider');
    expect(frame).not.toContain('↓ continue');
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
    expect(frameOf({ interruptArmed: true })).toContain('[Ctrl+C] exit (again)');
  });

  it('names the session picker keys while a session is being continued', () => {
    expect(
      frameOf({ sessions: [session], stripFocus: { kind: 'session', id: 'session-1' } }),
    ).toContain('↑/↓ select session · Enter resume · Esc return to prompt · [Ctrl+C] exit (twice)');
  });

  it('says how to send once the person is composing', () => {
    expect(frameOf({ text: 'hello', sessions: [session] })).toContain(
      'Enter start the chat · [Ctrl+J] newline · [Ctrl+C] exit (twice)',
    );
  });

  it('offers Continue beside the palette at an empty prompt when there are sessions to continue, and does not when there are none', () => {
    expect(frameOf({ sessions: [session] })).toContain(
      '[/] commands · ↓ continue · type a message to chat · [Ctrl+C] exit (twice)',
    );
    expect(frameOf({})).toContain(
      '[/] for commands · type a message to start a chat · [Ctrl+C] exit (twice)',
    );
  });
});

/**
 * The keyless line is the standing call to action (ADR-0146 §5, MVP-11 Step 2.4): it stays on screen when a live run or a strip row has the
 * focus, which suppressed it before. What `Enter` does FIRST in those states is said by the hint bar, so the two are asserted together.
 */
describe('the keyless line and the other things Enter does first', () => {
  const RUNNING_HOST: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: 'run-0001', cancelling: false },
    last: undefined,
  };
  const IDLE_HOST: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
  const PARKED = [{ runId: 'run-0002', kind: 'approval' as const, gates: 1 }];
  const LINE = 'No provider key yet · Enter connect · /providers';
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

  it('is shown with nothing else on offer for Enter, and the hint says Enter connects a provider', () => {
    const frame = frameOf({});
    expect(frame).toContain(LINE);
    expect(frame).toContain('Enter connect a provider · [/] commands · [Ctrl+C] exit (twice)');
  });

  it('is shown while a live run is in the view, where the hint bar says Enter shows the run first', () => {
    const frame = frameOf({ hostedRun: RUNNING_HOST });
    expect(frame).toContain(LINE);
    expect(frame).toContain('Enter show it');
    expect(frame, 'the idle keyless hint does not claim Enter for the setup here').not.toContain(
      'Enter connect a provider',
    );
  });

  it('is shown while a parked run is focused, where the hint bar says Enter opens its gate first', () => {
    const frame = frameOf({ parkedFocus: 'run-0002' });
    expect(frame).toContain(LINE);
    expect(frame).toContain('Enter open the gate');
    expect(frame).not.toContain('Enter connect a provider');
  });

  it('is shown once the run has ended and the focus has left the row', () => {
    const frame = frameOf({ hostedRun: IDLE_HOST });
    expect(frame).toContain(LINE);
    expect(frame).toContain('Enter connect a provider · [/] commands');
  });

  it('is absent with a key', () => {
    const frame = frameOf({ keyless: false });
    expect(frame).not.toContain('No provider key yet');
    expect(frame).not.toContain('Enter connect a provider');
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
    expect(bar).toContain('Enter say why');
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
    const frame = withoutStyles(view.lastFrame() ?? '');
    view.unmount();
    const line = frame.split('\n').find((candidate) => candidate.includes('||'));
    if (line === undefined) throw new Error(`no parked row in:\n${frame}`);
    return line;
  };

  it.each([
    ['none', 'Enter say why'],
    ['approval', 'Enter open'],
    ['several', 'Enter open'],
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

/** A keyless Home's hint for a draft (MVP-11 Step 2 review, C9a): a message is kept for the setup, a slash line is a command that `Enter` runs. */
describe('the keyless Home hint bar by what the draft is', () => {
  const frameOf = (text: string): string => {
    const view = render(
      <HomeView
        snapshot={{
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: true,
        }}
        editor={{ text, cursor: text.length }}
        nowMs={0}
        cols={120}
        rows={30}
        color={false}
        keyless
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('promises that a message is kept, because Enter opens the setup with it', () => {
    expect(frameOf('hello')).toContain('Enter connect a provider · your message is kept');
  });

  // `submit` trims the draft before it reads it, so a command line with blanks before its slash runs, and the hint must say so (round 2, U2).
  it.each(['/clear', '/doctor --deep', '/', '  /clear', ' /doctor --deep'])(
    'does not promise it for the command line %j: Enter runs the command, so the hint is the plain one',
    (text) => {
      const frame = frameOf(text);
      expect(frame).not.toContain('your message is kept');
      expect(frame).not.toContain('Enter connect a provider ·');
      expect(frame).toContain('Enter start the chat · [Ctrl+J] newline · [Ctrl+C] exit (twice)');
    },
  );

  it('a line that only CONTAINS a slash is a message', () => {
    expect(frameOf('see /etc/hosts')).toContain('your message is kept');
  });
});
