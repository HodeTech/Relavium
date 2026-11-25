/**
 * The `/doctor` popup's state machine on a manual clock ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): the quick tier read off the render, the consent line frozen when it is armed, every guard of its `Ctrl+Y`, one deep run per host that
 * `Esc` aborts, a completed result kept with its age, and nothing contacted that the line did not name.
 */
import type { ProviderId } from '@relavium/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENDPOINT_CHANGED_DETAIL } from '../chat/doctor-deep.js';
import { createProviderResolver } from '../engine/providers.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { CONSENT_LEAD, CONSENT_MCP, DOCTOR_STEP } from './doctor-popup.js';
import { deepRunInFlight, DOCTOR_PRESENCE_BOUND_MS, STILL_STOPPING } from './doctor-session.js';
import {
  CTRL,
  DOWN,
  ENTER,
  ESC,
  doctorRig,
  hanging,
  recordingProvider,
  settleWork,
  stubProbes,
  stubResolver,
} from './doctor.test-support.js';
import { CHORD_STEP_WINDOW_MS } from './popup-host.js';
import { popupLegend } from './popup-reducer.js';
import { legend } from '../render/tui/legend.js';

// Test keys assembled at runtime (no contiguous secret literal: leakwatch).
const KEY = ['sk', 'ant', 'doctor', 'ABCDEF1234567890'].join('-');
const OTHER_KEY = ['sk', 'proj', 'doctor', 'ZYXW98765432'].join('-');

afterEach(() => {
  vi.restoreAllMocks();
});

type Rig = ReturnType<typeof doctorRig>;

/** Open the doctor with one keyed provider (Anthropic), show its first frame and let the quick tier finish; the settle time passes. */
async function openedWithKey(r: Rig = doctorRig()) {
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  const probes = stubProbes(seam.resolver);
  const opened = r.open({ probes });
  expect(opened.opened).toBe(true);
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, anthropic, seam, probes };
}

/** Arm the line with `[d]`, let it be prepared, wait `ackAfter`, and acknowledge its frame: the dwell origin. Returns the acknowledgement's time. */
async function arm(r: Rig, ackAfter = 0): Promise<number> {
  r.press('d');
  await settleWork();
  expect(r.step()).toBe(DOCTOR_STEP.line);
  expect(r.content().kind).toBe('report');
  r.clock.advance(ackAfter);
  r.show();
  return r.clock.now();
}

const ctrlY = (r: Rig): boolean => r.press('y', CTRL);

describe('the quick tier (ADR-0148 §8)', () => {
  it('shows the checks with their words and a provider-keys row that warns at zero, under a heading of the outcome', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    const content = r.content(DOCTOR_STEP.checks);
    if (content.kind !== 'list') throw new Error('the checks are a list');
    expect(content.heading?.text).toBe('doctor: 1 warning');
    expect(content.rows.map((row) => [row.label, row.statusWord, row.detail])).toEqual([
      ['OS keychain', 'ok', 'reachable'],
      ['config', 'ok', 'valid'],
      ['wired tools', 'ok', 'none'],
      ['provider keys', 'warning', 'no provider has a key'],
    ]);
  });

  it('counts the providers with a key and never shows a key', async () => {
    const { r } = await openedWithKey();
    expect(r.words()).toContain('provider keys 1 of 4 providers have a key');
    expect(r.words()).not.toContain(KEY);
    expect(r.words()).not.toContain('ABCDEF');
  });

  it('reads nothing while it opens or is drawn: every read happens in the work it starts, one at a time', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const probes = stubProbes(seam.resolver);
    r.open({ probes });
    // Opening (and drawing what it opened) read nothing: the keychain probe and every presence read wait for the work.
    expect(probes.keychainReads()).toBe(0);
    expect(seam.availability).not.toHaveBeenCalled();
    r.show();
    r.host.getSnapshot();
    expect(probes.keychainReads()).toBe(0);
    expect(seam.availability).not.toHaveBeenCalled();
    await settleWork();
    expect(probes.keychainReads()).toBe(1);
    expect(seam.availability).toHaveBeenCalledTimes(4);
    // Moving through the rows and drawing them again reads nothing more; no value is ever read for the row.
    r.clock.advance(600);
    r.press('', DOWN);
    r.show();
    expect(seam.availability).toHaveBeenCalledTimes(4);
    expect(seam.keyFor).not.toHaveBeenCalled();
  });

  it('stops reading key presence at its bound and falls back on the host’s sample, saying what it could not check', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY, openai: OTHER_KEY }, providers: {} });
    // The first read blocks past the bound (a keychain that asked for access): the rest are not read.
    seam.availability.mockImplementationOnce(() => {
      r.clock.advance(DOCTOR_PRESENCE_BOUND_MS + 1);
      return {
        status: 'usable',
        source: { kind: 'keychain', label: 'OS keychain' },
        keychainHealth: 'available',
      };
    });
    r.open({
      probes: stubProbes(seam.resolver),
      cachedKeys: () => [{ id: 'gemini', usable: true }],
    });
    r.show();
    await settleWork();
    expect(seam.availability).toHaveBeenCalledTimes(1);
    expect(r.words()).toContain(
      '2 of 4 providers have a key; 2 could not be checked (OpenAI, DeepSeek)',
    );
  });

  it('[r] runs the quick tier again', async () => {
    const { r, probes } = await openedWithKey();
    expect(probes.keychainReads()).toBe(1);
    r.press('r');
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('loading');
    await settleWork();
    expect(probes.keychainReads()).toBe(2);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
  });

  it('a result for a popup that was closed lands nowhere', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const probes = stubProbes(seam.resolver);
    r.open({ probes });
    r.show();
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    await settleWork();
    // The work stopped with its popup: nothing was read after it closed, and nothing reopened.
    expect(probes.keychainReads()).toBe(0);
    expect(seam.availability).not.toHaveBeenCalled();
    expect(r.host.getSnapshot().open).toBe(false);
  });
});

describe('the consent line (ADR-0148 §8)', () => {
  it('names the ORIGINS that would receive a key, from the resolver’s pinned destination, and reads no key to build it', async () => {
    const r = doctorRig();
    const seam = stubResolver({
      keys: { anthropic: KEY, openai: OTHER_KEY },
      providers: {},
      origins: { openai: 'https://gateway.example' },
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    expect(r.words().split('\n')).toEqual([
      CONSENT_LEAD,
      '  https://api.anthropic.com',
      '  https://gateway.example',
      CONSENT_MCP,
    ]);
    expect(r.words()).not.toContain('api.openai.com');
    expect(seam.keyFor).not.toHaveBeenCalled();
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(legend(popupLegend(frame).items, popupLegend(frame).exit)).toBe(
      '[Ctrl+Y] send · Esc cancel',
    );
  });

  it('with no key there is nothing to confirm: no answer is offered and Ctrl+Y does nothing', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    expect(r.content().kind).toBe('empty');
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(deepRunInFlight(r.scope)).toBe(false);
  });
});

describe('the Ctrl+Y of the line, guard by guard (ADR-0148 §8)', () => {
  it('does not count before its frame was acknowledged (drawn, measured and flushed)', async () => {
    const { r, anthropic } = await openedWithKey();
    r.press('d');
    await settleWork();
    r.clock.advance(2000);
    // The line is drawn but its frame was never acknowledged: there is no dwell origin.
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.notifications.getSnapshot().current?.text).toContain('the line was not on screen yet');
  });

  it('does not count at 799 ms from the acknowledgement, though 1099 ms after the [d] that armed it', async () => {
    const { r, anthropic } = await openedWithKey();
    const ack = await arm(r, 300);
    r.clock.advance(799);
    expect(r.clock.now() - ack).toBe(799);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    // A refused chord disarms the line and says so.
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.notifications.getSnapshot().current?.text).toContain('Deep check not confirmed');
  });

  it('counts at 800 ms from the acknowledgement, and sends exactly one request to the provider the line named', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r, 300);
    r.clock.advance(800);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
    expect(anthropic.requests[0]?.key).toBe(KEY);
    await settleWork();
    expect(r.words()).toContain('Anthropic key works');
  });

  it('does not count after the confirmation window', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(CHORD_STEP_WINDOW_MS + 1);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('counts at the last moment of the window', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(CHORD_STEP_WINDOW_MS);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('does not count after a key that is not a navigation key arrived since the popup opened on the line (`/doctor --deep`)', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) }, true);
    expect(r.step()).toBe(DOCTOR_STEP.line);
    await settleWork();
    // A Ctrl+Y before the popup's first frame: the opening guard drops it (any other key would have disarmed the line), and it is counted.
    ctrlY(r);
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.notifications.getSnapshot().current?.text).toContain('a key was typed');
  });

  it('counts from a `/doctor --deep` line nobody typed over', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) }, true);
    await settleWork();
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('does not count after a key that is not a navigation key arrived since arming, even one its frame never took', async () => {
    const { r, anthropic } = await openedWithKey();
    r.press('d');
    await settleWork();
    r.hide();
    ctrlY(r); // dropped: its frame was not on screen; counted as typing (every other key would have disarmed the line)
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.reveal();
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.notifications.getSnapshot().current?.text).toContain('a key was typed');
  });

  it('does not count on the heels of another key (a double tap, a key repeat): the quiet gap', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(900);
    r.press('', DOWN); // a navigation key: it disarms nothing, but it is a key
    r.clock.advance(100);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('a frame acknowledged again (a re-measure, a custody blip) restarts the dwell at that acknowledgement', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(500);
    r.show(); // the same line, acknowledged again on a new measurement
    r.clock.advance(400); // 900 ms after the first acknowledgement, 400 after the second
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('a Ctrl+Y that came too late still locks the line it re-arms against a held key', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(CHORD_STEP_WINDOW_MS + 1);
    ctrlY(r); // too late: refused, the line disarmed, and the key stamped as a resolution
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(800);
    ctrlY(r); // 1400 ms after the late press: inside its lockout
    expect(anthropic.requests).toHaveLength(0);
  });

  it('a navigation key since arming is not typing: it neither disarms the line nor refuses the answer', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(100);
    r.press('', DOWN);
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.clock.advance(800);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('a paste answers nothing and disarms the line', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(1000);
    r.host.paste('\u0019');
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it.each([
    ['Esc', '', ESC],
    ['Ctrl+C (it disarms before it closes)', 'c', CTRL],
    ['a letter', 'x', {}],
    ['Enter', '', ENTER],
    ['another chord', 'n', CTRL],
  ] as const)('%s disarms the line, and the popup stays open', async (_name, input, key) => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(1000);
    r.press(input, key);
    expect(r.host.getSnapshot().open).toBe(true);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('a held Ctrl+Y cannot answer on its auto-repeat', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    // Pressed too early, then held: the repeats keep coming every 400 ms, long past the dwell.
    for (let at = 100; at <= 3000; at += 400) {
      r.clock.advance(at === 100 ? 100 : 400);
      ctrlY(r);
    }
    expect(anthropic.requests).toHaveLength(0);
  });

  it('[d] is ignored during the popup’s settle time', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(100);
    r.press('d');
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('a replaced frame (a resize) restarts the dwell', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(500);
    r.host.resized(100, 30);
    r.show(); // the frame drawn at the new size, acknowledged now
    r.clock.advance(400); // 900 ms after the first acknowledgement, 400 after the second
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('after a replaced frame the dwell counts from the new acknowledgement', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(500);
    r.host.resized(100, 30);
    r.show();
    r.clock.advance(800);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('a resize whose new frame was not acknowledged yet takes no answer, however long the first frame was up', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(500);
    r.host.resized(100, 30);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('any new frame of the line (here a scroll of it) restarts the dwell: it takes no answer until that frame is acknowledged', async () => {
    const { r, anthropic } = await openedWithKey();
    r.host.bindPageRows(() => 1); // a body one row high: the line's report scrolls
    await arm(r);
    r.clock.advance(400);
    r.press('', DOWN);
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });

  it('a Ctrl+Y that did not count locks a re-armed line for the lockout: a held key cannot answer the line it re-arms', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(100);
    ctrlY(r); // too soon: refused, the line disarmed
    const refusedAt = r.clock.now();
    r.clock.advance(600);
    const ack = await arm(r);
    r.clock.advance(800);
    expect(r.clock.now() - refusedAt).toBeLessThan(2000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    // That refusal restarted the lockout; once it has passed, a deliberate press on a line armed afresh counts.
    const secondRefusal = r.clock.now();
    expect(secondRefusal - ack).toBe(800);
    r.clock.advance(2100);
    await arm(r);
    r.clock.advance(800);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('a resize below the floor while the line is armed closes the popup unanswered and sends nothing', async () => {
    const { r, anthropic } = await openedWithKey();
    await arm(r);
    r.clock.advance(1000);
    r.host.resized(79, 24);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.notifications.getSnapshot().current?.text).toContain('nothing was answered');
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
  });
});

describe('the run is given exactly what the line named (ADR-0148 §8)', () => {
  /** A real resolver over a store of custom endpoints, its egress a recording fetch; swappable, as a host that read its store again would be. */
  function gateway(env: Record<string, string>) {
    const origins: string[] = [];
    const fetch = vi.fn<FetchLike>((input) => {
      const url = input instanceof Request ? input.url : String(input);
      origins.push(new URL(url).origin);
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const row = (id: ProviderId, baseUrl: string) => ({
      id: `synthetic-${id}`,
      name: id,
      displayName: id,
      baseUrl,
      defaultHeaders: {},
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const build = (openai: string) =>
      createProviderResolver(env, undefined, {
        providerStore: {
          list: () => [
            row('openai', openai),
            row('deepseek', 'https://deepseek-gateway.example/v1'),
          ],
        },
        validatedFetch: fetch,
      });
    let current = build('https://first-gateway.example/v1');
    const resolver = {
      resolveProvider: (id: ProviderId) => current.resolveProvider(id),
      keyFor: (id: ProviderId) => current.keyFor(id),
      availability: (id: ProviderId) => {
        const observed = current.availability;
        if (observed === undefined) throw new Error('the real resolver observes availability');
        return observed(id);
      },
      endpointContext: (id: ProviderId) => {
        const context = current.endpointContext;
        if (context === undefined) throw new Error('the real resolver pins its destinations');
        return context(id);
      },
    };
    return {
      resolver,
      origins,
      fetch,
      moveOpenAiTo: (url: string) => {
        current = build(url);
      },
    };
  }

  it('a custom endpoint changed after arming is never contacted: that provider fails and nothing is sent', async () => {
    const env: Record<string, string> = { RELAVIUM_OPENAI_API_KEY: OTHER_KEY };
    const seam = gateway(env);
    const r = doctorRig();
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    expect(r.words()).toContain('https://first-gateway.example');
    seam.moveOpenAiTo('https://second-gateway.example/v1');
    r.clock.advance(1000);
    ctrlY(r);
    await vi.waitFor(() => expect(r.content(DOCTOR_STEP.checks).kind).toBe('list'));
    expect(r.words()).toContain(ENDPOINT_CHANGED_DETAIL);
    expect(seam.fetch).not.toHaveBeenCalled();
    expect(seam.origins).toEqual([]);
  });

  it('without a change, every request goes to an origin the line named (the control of the test above)', async () => {
    const env: Record<string, string> = { RELAVIUM_OPENAI_API_KEY: OTHER_KEY };
    const seam = gateway(env);
    const r = doctorRig();
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    const named = r.words();
    r.clock.advance(1000);
    ctrlY(r);
    await vi.waitFor(() => expect(r.content(DOCTOR_STEP.checks).kind).toBe('list'));
    expect(seam.origins.length).toBeGreaterThan(0);
    for (const origin of seam.origins) expect(named).toContain(`  ${origin}`);
  });

  it('a key stored after arming is not contacted: the run reads no provider the line did not name', async () => {
    const env: Record<string, string> = { RELAVIUM_OPENAI_API_KEY: OTHER_KEY };
    const seam = gateway(env);
    const r = doctorRig();
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    expect(r.words()).not.toContain('deepseek-gateway');
    env['RELAVIUM_DEEPSEEK_API_KEY'] = KEY; // stored between the line and the answer
    r.clock.advance(1000);
    ctrlY(r);
    await vi.waitFor(() => expect(r.content(DOCTOR_STEP.checks).kind).toBe('list'));
    expect(seam.origins).not.toContain('https://deepseek-gateway.example');
    expect(r.words()).not.toContain('DeepSeek');
  });
});

describe('one deep run per host, and Esc aborts it (ADR-0148 §8)', () => {
  it('an injected hanging provider: Esc aborts at once and the abort reaches the request; reopening and pressing [d] three times sends no second request', async () => {
    const r = doctorRig();
    const stall = hanging();
    const anthropic = recordingProvider('anthropic', () => stall.promise);
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
    const signal = anthropic.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);
    // The running step says its cancel key, and it is real.
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(legend(popupLegend(frame).items, popupLegend(frame).exit)).toBe('Esc cancel');
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(signal?.aborted).toBe(true);
    await settleWork();
    // The provider ignores the abort: its request has not settled, so the run is still in flight.
    expect(deepRunInFlight(r.scope)).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      r.open({ probes: stubProbes(seam.resolver) });
      r.show();
      await settleWork();
      r.clock.advance(600);
      r.press('d');
      await settleWork();
      expect(r.words()).toContain(STILL_STOPPING);
      r.show();
      r.clock.advance(1000);
      ctrlY(r);
      r.press('', ESC); // back to the checks
      r.press('', ESC); // and closed
      expect(r.host.getSnapshot().open).toBe(false);
    }
    expect(anthropic.requests).toHaveLength(1);
    // Once the request settles the run is over, and a new line can be armed.
    stall.release();
    await settleWork();
    expect(deepRunInFlight(r.scope)).toBe(false);
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    expect(r.words()).toContain(CONSENT_LEAD);
    r.press('', ESC);
    r.press('', ESC);
  });

  it('a completed result is kept for the host, shown again with its age, and [r] keeps it', async () => {
    const { r, anthropic, seam } = await openedWithKey();
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(anthropic.requests).toHaveLength(1);
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    r.clock.advance(65_000);
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    expect(r.words()).toContain('Deep check, 1m05s ago');
    expect(r.words()).toContain('Anthropic key works');
    r.clock.advance(600);
    r.press('r');
    await settleWork();
    expect(r.words()).toContain('Anthropic key works');
    expect(anthropic.requests).toHaveLength(1);
  });

  it('the deep run is chained to the work owner: stopping the owner aborts the request', async () => {
    const r = doctorRig();
    const stall = hanging();
    const anthropic = recordingProvider('anthropic', () => stall.promise);
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const stop = new AbortController();
    r.open({
      probes: stubProbes(seam.resolver),
      workOwner: {
        signal: stop.signal,
        work: { retainWork: <T>(factory: () => Promise<T>): Promise<T> => factory() },
        assertAdmitting: () => undefined,
        enter: <T>(operation: () => Promise<T>): Promise<T> => operation(),
        failure: () => undefined,
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests[0]?.signal?.aborted).toBe(false);
    stop.abort();
    expect(anthropic.requests[0]?.signal?.aborted).toBe(true);
    expect(r.host.getSnapshot().open).toBe(true);
    stall.release();
    r.press('', ESC);
  });

  it('a fault while the deep result lands is the owner’s, never an unhandled rejection', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const failures: unknown[] = [];
    const cause = new TypeError('a listener of the popup failed');
    r.open({
      probes: stubProbes(seam.resolver),
      workOwner: {
        signal: new AbortController().signal,
        work: { retainWork: <T>(factory: () => Promise<T>): Promise<T> => factory() },
        assertAdmitting: () => undefined,
        enter: <T>(operation: () => Promise<T>): Promise<T> => operation(),
        failure: (fault) => {
          failures.push(fault);
        },
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    let thrown = false;
    const stop = r.host.subscribe(() => {
      if (!thrown && r.words().includes('Anthropic key works')) {
        thrown = true;
        throw cause;
      }
    });
    ctrlY(r);
    await settleWork();
    stop();
    expect(thrown).toBe(true);
    expect(failures).toContain(cause);
    r.press('', ESC);
  });

  it('an aborted run is not kept', async () => {
    const r = doctorRig();
    const stall = hanging();
    const anthropic = recordingProvider('anthropic', () => stall.promise);
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    r.press('', ESC);
    stall.release();
    await settleWork();
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    expect(r.words()).not.toContain('Deep check');
    r.press('', ESC);
  });
});

describe('MCP is only reported, and only in a chat (ADR-0148 §8)', () => {
  const MCP_ROW = { id: 'mcp:files', label: 'files', status: 'ok' as const, detail: 'connected' };

  it.each([
    ['home', false],
    ['home-chat', true],
    ['standalone-chat', true],
  ] as const)('on %s the deep rows carry the session’s MCP report: %s', async (surface, shown) => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const deepMcp = vi.fn(() => Promise.resolve([MCP_ROW]));
    r.open({ probes: stubProbes(seam.resolver, { deepMcp }), surface });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(r.words().includes('ok files connected')).toBe(shown);
    expect(deepMcp).toHaveBeenCalledTimes(shown ? 1 : 0);
  });
});

describe('what a provider says stays out of the row and the copy (ADR-0148 §8)', () => {
  it('a key-echoing provider error is redacted in the row, the detail and the copied text', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic', () =>
      Promise.reject(new Error(`401 invalid x-api-key ${KEY}; also tried ${OTHER_KEY}`)),
    );
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const copied: string[] = [];
    r.open({
      probes: stubProbes(seam.resolver),
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(r.words()).toContain('Anthropic');
    expect(r.words()).not.toContain(KEY);
    expect(r.words()).not.toContain(OTHER_KEY);
    r.clock.advance(600);
    r.press('c');
    await settleWork();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('Anthropic');
    expect(copied[0]).not.toContain(KEY);
    expect(copied[0]).not.toContain(OTHER_KEY);
    // The detail step shows the whole detail, scrubbed the same way.
    const content = r.content(DOCTOR_STEP.checks);
    if (content.kind !== 'list') throw new Error('list');
    const index = content.rows.findIndex((row) => row.label === 'Anthropic');
    for (let step = 0; step < index; step += 1) r.press('', DOWN);
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    expect(r.words()).not.toContain(KEY);
    expect(r.words()).not.toContain(OTHER_KEY);
  });
});
