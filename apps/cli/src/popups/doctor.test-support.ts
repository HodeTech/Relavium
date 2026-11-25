/**
 * Test support for the `/doctor` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): a popup host on a manual monotonic clock, a doctor opened on it with the work's pauses made microtasks, a provider seam whose every read
 * is counted, and providers that record what they were asked. Nothing here reaches a keychain, a network or a process.
 */

import type { LlmProvider, LlmRequest, LlmResult, ProviderId } from '@relavium/llm';

type RequestSignal = LlmRequest['signal'];
import { vi } from 'vitest';

import type { DoctorCheck, DoctorProbes } from '../chat/doctor.js';
import type { ProviderKeyAvailability, ProviderResolver } from '../engine/providers.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { openDoctorPopup } from './doctor-session.js';
import type { DoctorPort } from './doctor-port.js';
import type { PopupContent } from './frame-model.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import {
  createPopupHost,
  type PopupHandlers,
  type PopupHost,
  type PopupOpenResult,
} from './popup-host.js';
import { currentStep, type PopupKey } from './popup-reducer.js';

/** A manual timer and clock: `advance` runs what falls due, in order. */
export function manualClock() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run, cancelled: false };
    pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    schedule,
    now: () => now,
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = pending
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.run();
      }
      now = end;
    },
  };
}

/** Let the doctor's work run to its next real wait (its pauses are microtasks here). */
export async function settleWork(): Promise<void> {
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
}

/** What a provider that answered says: one word, complete usage. */
export const PONG: LlmResult = {
  content: [{ type: 'text', text: 'pong' }],
  stopReason: 'stop',
  usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
  raw: undefined,
};

/** A provider that records each request (its signal and the key it was given) and answers as `answer` does. */
export function recordingProvider(
  id: ProviderId,
  answer: (request: LlmRequest, key: string) => Promise<LlmResult> = () => Promise.resolve(PONG),
): LlmProvider & {
  readonly requests: { readonly signal: RequestSignal; readonly key: string }[];
} {
  const requests: { readonly signal: RequestSignal; readonly key: string }[] = [];
  return {
    id,
    requests,
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: (request, key) => {
      requests.push({ signal: request.signal, key });
      return answer(request, key);
    },
    stream: () => {
      throw new Error('the doctor never streams');
    },
  };
}

/** An answer that never comes until `release`, and that ignores every abort: a provider that hangs. */
export function hanging(): { readonly promise: Promise<LlmResult>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<LlmResult>((resolve) => {
    release = () => {
      resolve(PONG);
    };
  });
  return { promise, release };
}

/** A provider seam over mutable state: which keys are present, each provider's adapter and its pinned destination. Every read is counted. */
export function stubResolver(initial: {
  readonly keys: Partial<Record<ProviderId, string>>;
  readonly providers: Partial<Record<ProviderId, LlmProvider>>;
  readonly origins?: Partial<Record<ProviderId, string>>;
}) {
  const keys: Partial<Record<ProviderId, string>> = { ...initial.keys };
  const providers: Partial<Record<ProviderId, LlmProvider>> = { ...initial.providers };
  const origins: Partial<Record<ProviderId, string>> = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    deepseek: 'https://api.deepseek.com',
    ...initial.origins,
  };
  const availability = vi.fn(
    (id: ProviderId): ProviderKeyAvailability =>
      keys[id] === undefined
        ? { status: 'missing', keychainHealth: 'available' }
        : {
            status: 'usable',
            source: { kind: 'keychain', label: 'OS keychain' },
            keychainHealth: 'available',
          },
  );
  const keyFor = vi.fn((id: ProviderId): string => {
    const key = keys[id];
    if (key === undefined) throw new Error(`no key for ${id}`);
    return key;
  });
  const resolver: ProviderResolver = {
    resolveProvider: (id) => providers[id],
    keyFor,
    availability,
    endpointContext: (id) => {
      const origin = origins[id];
      return origin === undefined
        ? 'Custom endpoint configuration is invalid.'
        : `${origin.includes('example') ? 'Custom' : 'Official'} endpoint: ${origin}`;
    },
  };
  return { resolver, keys, providers, origins, availability, keyFor };
}

/** The quick tier's probes over `resolver`, every one a spy that passes. */
export function stubProbes(
  resolver: ProviderResolver | undefined,
  over: Partial<DoctorProbes> = {},
): DoctorProbes & { readonly keychainReads: () => number } {
  let reads = 0;
  const keychain = (): void => {
    reads += 1;
  };
  return {
    keychain,
    keychainReads: () => reads,
    config: () => undefined,
    toolHost: {},
    ...(resolver === undefined ? {} : { providers: resolver }),
    ...over,
  };
}

/** A popup host on a manual clock, with the doctor opened on it and its frame "on screen" unless a test says otherwise. */
export function doctorRig(options: { readonly settleMs?: number } = {}) {
  const clock = manualClock();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const history = createChordHistory();
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history,
    placement: 'overlay',
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  // The handlers the doctor gave the host, so a test can call one the keys cannot reach (a control the step does not list).
  let handlers: PopupHandlers | undefined;
  const spying: PopupHost = {
    ...host,
    openForUser: (spec, given) => {
      handlers = given;
      return host.openForUser(spec, given);
    },
  };
  let painted = true;
  host.bindVisibility(() => painted);
  // A host's gate is bound when it mounts, and a host with none opens nothing: this rig's host lets every open through.
  host.bindOpenGate(() => undefined);
  // The rows a page moves, as a standard popup at 80×24 has them: a short report does not scroll.
  host.bindPageRows(() => 18);
  const scope = {};
  const open = (
    port: Omit<DoctorPort, 'scope' | 'surface' | 'resultKey'> &
      Partial<Pick<DoctorPort, 'surface' | 'resultKey'>>,
    deep = false,
    /** How the checks give the loop back between two reads: a microtask unless a test holds them. */
    yieldToLoop: () => Promise<void> = () => Promise.resolve(),
  ): PopupOpenResult =>
    openDoctorPopup({
      host: spying,
      port: { scope, surface: 'home', resultKey: 'home', ...port },
      deep,
      origin: 'home',
      now: clock.now,
      yieldToLoop,
    });
  const content = (step?: number): PopupContent => {
    const frame = host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup is open');
    const state = frame.steps[step ?? frame.stepIndex];
    if (state === undefined) throw new Error('no such step');
    return state.content;
  };
  return {
    host,
    clock,
    notifications,
    history,
    scope,
    open,
    content,
    /** The handlers of the popup opened last (what the host calls for a key), for a test that calls one directly. */
    handlers: (): PopupHandlers | undefined => handlers,
    /** The current frame was measured and flushed now (a NEW frame: the dwell of a line starts here). */
    show: (): void => host.shown(host.getSnapshot()),
    hide: (): void => {
      painted = false;
    },
    reveal: (): void => {
      painted = true;
    },
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    /** The words of the current step, whatever its kind: the rows of a list, the lines of a report, the text of a state. */
    words: (): string => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return '';
      const { state } = currentStep(frame);
      const shown = state.content;
      switch (shown.kind) {
        case 'list':
          return [
            shown.heading?.text ?? '',
            ...shown.rows.map((row) => `${row.statusWord ?? ''} ${row.label} ${row.detail ?? ''}`),
          ].join('\n');
        case 'report':
          return shown.lines.join('\n');
        case 'loading':
          return shown.what;
        case 'empty':
        case 'error':
          return `${shown.what}\n${shown.next}`;
      }
    },
  };
}

export const ESC: PopupKey = { escape: true };
export const ENTER: PopupKey = { return: true };
export const DOWN: PopupKey = { downArrow: true };
export const CTRL: PopupKey = { ctrl: true };

/** A check, for a builder's test. */
export const check = (
  id: string,
  status: DoctorCheck['status'],
  label = id,
  detail = 'detail',
): DoctorCheck => ({ id, label, status, detail });
