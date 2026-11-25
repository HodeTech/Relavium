/**
 * The `/doctor` popup's state machine on a manual clock ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): the quick tier read off the render, the consent line frozen when it is armed, every guard of its `Ctrl+Y`, one deep run per host that
 * `Esc` aborts, a completed result kept with its age, and nothing contacted that the line did not name.
 */
import type { ProviderId } from '@relavium/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProviderResolver } from '../engine/providers.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { CONSENT_LEAD, CONSENT_MCP, DOCTOR_STEP } from './doctor-popup.js';
import type { DoctorPort } from './doctor-port.js';
import {
  chordRefusedText,
  deepRunInFlight,
  DOCTOR_PRESENCE_BOUND_MS,
  STILL_STOPPING,
} from './doctor-session.js';
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
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
import { popupCopyNotice } from './popup-copy.js';
import { CHORD_STEP_WINDOW_MS, type ChordRefusal } from './popup-host.js';
import { currentStep, popupLegend } from './popup-reducer.js';
import { legend } from '../render/tui/legend.js';
import { displayWidth } from '../render/tui/viewport.js';

/** What a provider whose endpoint changed after the line says: pinned by literal (the sentence tells the person nothing was sent). */
const ENDPOINT_CHANGED =
  'not contacted: its endpoint changed after the confirmation was shown, so nothing was sent';

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
    // The line's legend: the answer key first, then the way out, which goes back to the checks it came from.
    expect(legend(popupLegend(frame).items, popupLegend(frame).exit)).toBe(
      '[Ctrl+Y] send · Esc back',
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
    expect(r.notifications.getSnapshot().current?.text).toContain(
      'Nothing was sent: too soon, wait 2 s.',
    );
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
    expect(r.notifications.getSnapshot().current?.text).toContain(
      'Nothing was sent: too soon, wait 2 s.',
    );
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
    // A Ctrl+Y before the popup's first frame: the opening guard drops it, and the host disarms the line at once and says why: the line is
    // gone, the person is back on the checks, and nothing was sent.
    ctrlY(r);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.notifications.getSnapshot().current?.text).toBe(chordRefusedText('unseen'));
    expect(anthropic.requests).toHaveLength(0);
    // A second one, on the checks (nothing to answer there), sends nothing either.
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    // `[d]` asks again, and a patient press answers the new line.
    r.clock.advance(3000);
    await arm(r, 0);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
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
    ctrlY(r); // dropped: its frame was not on screen
    // The host disarmed the line at once and said why: the line is gone, back on the checks, nothing sent.
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.notifications.getSnapshot().current?.text).toBe(chordRefusedText('unseen'));
    expect(anthropic.requests).toHaveLength(0);
    r.reveal();
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(0);
    // `[d]` asks again, and a patient press answers the new line.
    r.clock.advance(3000);
    await arm(r, 0);
    r.clock.advance(1000);
    ctrlY(r);
    expect(anthropic.requests).toHaveLength(1);
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
    expect(r.words()).toContain(ENDPOINT_CHANGED);
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

/** The letters the checks step answers to now, as the host reads them. */
function controlKeys(r: Rig): string[] {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup is open');
  return (currentStep(frame).spec.controls ?? []).map((control) => control.key);
}

/** The legend the popup draws now. */
function legendOf(r: Rig): string {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup is open');
  const { items, exit } = popupLegend(frame);
  return legend(items, exit);
}

/** A loop whose pauses can be held: while held, a pause waits until `release`. */
function holdableLoop() {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    yieldToLoop: (): Promise<void> =>
      held
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(),
    hold: (): void => {
      held = true;
    },
    release: (): void => {
      held = false;
      for (const resume of waiting.splice(0)) resume();
    },
  };
}

describe('[c] copies a report only when there is one (D1)', () => {
  const FAILING = (): { globalArtifacts: () => never } => ({
    globalArtifacts: () => {
      throw new Error('the global folder could not be read');
    },
  });

  it('the checks could not run: the step is the error, [c] is not listed, and a [c] pressed anyway copies nothing', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    const copied: string[] = [];
    r.open({
      probes: stubProbes(seam.resolver, FAILING()),
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).toContain('The checks could not run.');
    expect(controlKeys(r)).toEqual(['r', 'd']);
    expect(legendOf(r)).not.toContain('copy');
    r.press('c');
    await settleWork();
    expect(copied).toEqual([]);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('the copy itself refuses when the checks are not shown, whatever reached it: the handler called directly sends nothing', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    const copied: string[] = [];
    const opened = r.open({
      probes: stubProbes(seam.resolver, FAILING()),
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    if (!opened.opened) throw new Error('open');
    r.show();
    await settleWork();
    r.clock.advance(600);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    r.handlers()?.control?.(opened.context, 'c');
    await settleWork();
    expect(copied).toEqual([]);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('with a kept deep result and the checks reloading, there is still no report: [c] is not listed and the copy sends nothing', async () => {
    const r = doctorRig();
    const loop = holdableLoop();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const copied: string[] = [];
    const opened = r.open(
      {
        probes: stubProbes(seam.resolver),
        clipboard: (text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        },
      },
      false,
      loop.yieldToLoop,
    );
    if (!opened.opened) throw new Error('open');
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(r.words()).toContain('Anthropic key works');
    expect(controlKeys(r)).toEqual(['r', 'd', 'c']);
    r.clock.advance(600);
    // [r] again, and the quick tier waits: the deep result is kept, but the step is loading and has no report to copy.
    loop.hold();
    r.press('r');
    await settleWork();
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('loading');
    expect(controlKeys(r)).toEqual(['r', 'd']);
    r.press('c');
    r.handlers()?.control?.(opened.context, 'c');
    await settleWork();
    expect(copied).toEqual([]);
    // Once the checks land again the copy is listed and works.
    loop.release();
    await settleWork();
    expect(controlKeys(r)).toEqual(['r', 'd', 'c']);
    r.clock.advance(600);
    r.press('c');
    await settleWork();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('doctor: ');
    expect(copied[0]).toContain('OS keychain');
  });

  it('the deep check could not run: [c] is not listed there either, and [r] and [d] still are', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const deepMcp = vi.fn(() => Promise.reject(new Error('mcp down')));
    r.open({ probes: stubProbes(seam.resolver, { deepMcp }), surface: 'home-chat' });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(controlKeys(r)).toEqual(['r', 'd']);
  });
});

describe('the deep rows’ age is the age at the moment the person looks (D2)', () => {
  /** A kept deep result, landed now, on a popup that stays open. */
  async function withKeptResult() {
    const opened = await openedWithKey();
    await arm(opened.r);
    opened.r.clock.advance(1000);
    ctrlY(opened.r);
    await settleWork();
    expect(opened.r.words()).toContain('Deep check, 0s ago');
    return opened;
  }

  it('coming back from a row’s detail reads the age again', async () => {
    const { r } = await withKeptResult();
    r.clock.advance(13_000);
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    r.clock.advance(7000);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.words()).toContain('Deep check, 20s ago');
    expect(r.words()).not.toContain('Deep check, 0s ago');
  });

  it('coming back from the confirmation line reads the age again, after ten minutes as after ten seconds', async () => {
    const { r } = await withKeptResult();
    r.clock.advance(613_000);
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.words()).toContain('Deep check, 10m13s ago');
  });

  it('[r] lands with the age at the moment it lands, not at the moment it was pressed', async () => {
    const { r, seam } = await withKeptResult();
    r.clock.advance(30_000);
    // The first presence read takes a second and a half (a keychain that asks): the rows land that much later.
    seam.availability.mockImplementationOnce(() => {
      r.clock.advance(1500);
      return {
        status: 'usable',
        source: { kind: 'keychain', label: 'OS keychain' },
        keychainHealth: 'available',
      };
    });
    r.press('r');
    await settleWork();
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
    expect(r.words()).toContain('Deep check, 31s ago');
  });

  it('a step that says the checks could not run is left as it is when the popup comes back to it', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    r.open({
      probes: stubProbes(seam.resolver, {
        globalArtifacts: () => {
          throw new Error('the global folder could not be read');
        },
      }),
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).toContain('The checks could not run.');
  });
});

describe('the detail step says only what is true of its keys (D3)', () => {
  it('[r] and [c] do nothing on a row’s detail, and Esc goes back to the checks where they work', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    const copied: string[] = [];
    let reads = 0;
    const probes = stubProbes(seam.resolver, {
      keychain: () => {
        reads += 1;
        throw new Error('backend down');
      },
    });
    r.open({
      probes,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    expect(r.words()).toContain('Esc goes back to the checks, where [r] checks again.');
    expect(r.words()).not.toContain('Press [r]');
    expect(legendOf(r)).not.toContain('[r]');
    expect(legendOf(r)).not.toContain('[c]');
    const before = reads;
    r.press('r');
    r.press('c');
    await settleWork();
    expect(reads).toBe(before);
    expect(copied).toEqual([]);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    // What the sentence promises: back on the checks, [r] checks again.
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    r.press('r');
    await settleWork();
    expect(reads).toBe(before + 1);
  });
});

describe('the quick tier’s presence reads and its bound (D6)', () => {
  it('the bound is two seconds, and a read that ends exactly on it is still followed by the next one', async () => {
    expect(DOCTOR_PRESENCE_BOUND_MS).toBe(2000);
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY, openai: OTHER_KEY }, providers: {} });
    const usable = {
      status: 'usable',
      source: { kind: 'keychain', label: 'OS keychain' },
      keychainHealth: 'available',
    } as const;
    // The first read takes exactly the bound; the second takes one millisecond more: the third is past it.
    seam.availability.mockImplementationOnce(() => {
      r.clock.advance(2000);
      return usable;
    });
    seam.availability.mockImplementationOnce(() => {
      r.clock.advance(1);
      return usable;
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    expect(seam.availability).toHaveBeenCalledTimes(2);
    expect(r.words()).toContain(
      '2 of 4 providers have a key; 2 could not be checked (Google Gemini, DeepSeek)',
    );
  });
});

describe('what the person is told is short enough for the popup and in these words (D4)', () => {
  // The most columns a notification may take in a popup at 80×24: the host's own constant, the room beside the way back in the legend row.
  const inner = POPUP_NOTICE_MAX_COLUMNS;

  it.each([
    ['unseen', 'Nothing was sent: too soon, wait 2 s. [d] asks again.'],
    ['early', 'Nothing was sent: too soon, wait 2 s. [d] asks again.'],
    ['expired', 'Nothing was sent: time ran out. [d] asks again.'],
    ['typed', 'Nothing was sent: a key was typed. [d] asks again.'],
    ['cut', 'Nothing was sent: the line was cut. [d] asks again.'],
  ] as const satisfies readonly (readonly [ChordRefusal, string])[])(
    'a Ctrl+Y that did not count (%s) says why, that nothing was sent, and how to ask again',
    (reason, words) => {
      expect(chordRefusedText(reason)).toBe(words);
      expect(displayWidth(chordRefusedText(reason))).toBeLessThanOrEqual(inner);
    },
  );

  it('every sentence of the copy fits the room a notification has in a popup at 80 columns, and the still-stopping line fits a row of its text', () => {
    const biggest = 99_999; // a report cannot be longer than the terminal’s clipboard takes
    const said = [
      popupCopyNotice('Doctor', { kind: 'written', characters: biggest }),
      popupCopyNotice('Doctor', { kind: 'failed' }),
      popupCopyNotice('Doctor', { kind: 'too-large', base64Length: 80_000, limit: 74_994 }),
    ];
    for (const text of said) {
      if (text === undefined) throw new Error('a sentence');
      expect(displayWidth(text), text).toBeLessThanOrEqual(inner);
    }
    // The still-stopping sentence is the line step's text, wrapped in a row of the popup, not a notification.
    expect(displayWidth(STILL_STOPPING)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
  });

  it('says what happened to the copy, in these words, and nothing when nothing was selected', () => {
    // The doctor's sentences are the family every popup's copy speaks (`popup-copy.ts`), under the doctor's name.
    expect(popupCopyNotice('Doctor', { kind: 'written', characters: 1234 })).toBe(
      'Doctor: sent 1234 characters to the clipboard.',
    );
    expect(popupCopyNotice('Doctor', { kind: 'failed' })).toBe(
      'Doctor: the clipboard request failed.',
    );
    expect(
      popupCopyNotice('Doctor', { kind: 'too-large', base64Length: 80_000, limit: 74_994 }),
    ).toBe('Doctor: too large for the clipboard.');
    expect(popupCopyNotice('Doctor', { kind: 'empty' })).toBeUndefined();
  });

  it('the line that is still stopping says so in these words', () => {
    expect(STILL_STOPPING).toBe(
      'The last deep check is still stopping, so nothing new is sent yet.',
    );
  });

  it('[c] with no way to copy says so, and the report goes nowhere', async () => {
    const { r } = await openedWithKey();
    r.press('c');
    await settleWork();
    expect(r.notifications.getSnapshot().current?.text).toBe(
      'Doctor: copying is not available here.',
    );
  });

  it('[c] says how many characters went to the terminal clipboard', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
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
    r.press('c');
    await settleWork();
    expect(copied).toHaveLength(1);
    expect(r.notifications.getSnapshot().current?.text).toBe(
      `Doctor: sent ${String(copied[0]?.length)} characters to the clipboard.`,
    );
  });

  it.each([
    [false, '  ✓ ok  OS keychain  reachable'],
    [true, '  ok  OS keychain  reachable'],
  ] as const)(
    'the copied report is in the glyph form of the screen (plain glyphs: %s)',
    async (plain, line) => {
      const r = doctorRig();
      const seam = stubResolver({ keys: {}, providers: {} });
      const copied: string[] = [];
      r.open({
        probes: stubProbes(seam.resolver),
        plainGlyphs: plain,
        clipboard: (text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        },
      });
      r.show();
      await settleWork();
      r.clock.advance(600);
      r.press('c');
      await settleWork();
      expect(copied[0]?.split('\n')).toContain(line);
    },
  );
});

describe('the deep tier’s run is refused a destination it can no longer name (D6, B13)', () => {
  it('a destination the resolver can no longer name after arming is never contacted', async () => {
    const { r, anthropic, seam } = await openedWithKey();
    await arm(r);
    delete seam.origins.anthropic; // the resolver can no longer say where the key would go
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(anthropic.requests).toHaveLength(0);
    expect(seam.keyFor).not.toHaveBeenCalled();
    expect(r.words()).toContain(ENDPOINT_CHANGED);
  });
});

describe('what a kept result shows is the session’s own (D6, B32, B48)', () => {
  it('a kept deep result shows the MCP rows only in the session that reported them, and the provider rows in any', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const deepMcp = vi.fn(() =>
      Promise.resolve([
        { id: 'mcp:files', label: 'files', status: 'ok' as const, detail: 'connected' },
      ]),
    );
    r.open({
      probes: stubProbes(seam.resolver, { deepMcp }),
      surface: 'home-chat',
      resultKey: 'session-A',
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(r.words()).toContain('ok files connected');
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    // The same host, another session: the provider rows are shown again, the MCP rows are not.
    r.open({
      probes: stubProbes(seam.resolver, { deepMcp }),
      surface: 'home-chat',
      resultKey: 'session-B',
    });
    r.show();
    await settleWork();
    expect(r.words()).toContain('Anthropic key works');
    expect(r.words()).not.toContain('files connected');
    r.press('', ESC);
    // And in the session that reported them, they are still there.
    r.open({
      probes: stubProbes(seam.resolver, { deepMcp }),
      surface: 'home-chat',
      resultKey: 'session-A',
    });
    r.show();
    await settleWork();
    expect(r.words()).toContain('ok files connected');
  });

  it('a provider that has a key but whose destination cannot be named is not on the line, and nothing is offered to answer', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    delete seam.origins.anthropic;
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(r.content().kind).toBe('empty');
    expect(r.words()).toContain('No provider’s key and endpoint could both be read');
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(anthropic.requests).toHaveLength(0);
    expect(seam.keyFor).not.toHaveBeenCalled();
    expect(deepRunInFlight(r.scope)).toBe(false);
  });
});

describe('a line that does not fit the page is never answered (D5)', () => {
  it('four providers at the longest origins: the line says it cannot be confirmed, and a Ctrl+Y on it sends nothing', async () => {
    const r = doctorRig();
    const providers = {
      anthropic: recordingProvider('anthropic'),
      openai: recordingProvider('openai'),
      gemini: recordingProvider('gemini'),
      deepseek: recordingProvider('deepseek'),
    };
    const host = (lead: string): string =>
      `https://${[lead.repeat(63), lead.repeat(63), lead.repeat(63), lead.repeat(61)].join('.')}:65535`;
    const seam = stubResolver({
      keys: { anthropic: KEY, openai: KEY, gemini: KEY, deepseek: KEY },
      providers,
      origins: {
        anthropic: host('a'),
        openai: host('b'),
        gemini: host('c'),
        deepseek: host('d'),
      },
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    r.show();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(r.content().kind).toBe('empty');
    expect(r.words()).toContain('These destinations are too long to confirm, so nothing is sent.');
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    for (const provider of Object.values(providers)) expect(provider.requests).toEqual([]);
    expect(seam.keyFor).not.toHaveBeenCalled();
    expect(deepRunInFlight(r.scope)).toBe(false);
  });
});

describe('the heading counts the deep rows (D6, E11)', () => {
  it('a provider that failed makes the checks a failure', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic', () => Promise.reject(new Error('boom')));
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    const content = r.content(DOCTOR_STEP.checks);
    if (content.kind !== 'list') throw new Error('list');
    expect(content.heading?.text).toBe('doctor: 1 check failed');
  });
});

describe('an MCP server’s label is as untrusted as its detail, in the copy and in the detail step (D6, E14, E33)', () => {
  /** A chat whose session reports one MCP server with the label `label`, its deep result landed. */
  async function withMcpLabel(
    label: string,
    clipboard?: (text: string) => { kind: 'written'; characters: number },
  ) {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const deepMcp = vi.fn(() =>
      Promise.resolve([{ id: 'mcp:evil', label, status: 'ok' as const, detail: 'connected' }]),
    );
    r.open({
      probes: stubProbes(seam.resolver, { deepMcp }),
      surface: 'home-chat',
      ...(clipboard === undefined ? {} : { clipboard }),
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    r.clock.advance(600);
    return r;
  }

  it('the copied report carries neither an escape nor a key token from the label', async () => {
    const copied: string[] = [];
    const r = await withMcpLabel('files\u001b[31m [Ctrl+Y] send', (text) => {
      copied.push(text);
      return { kind: 'written', characters: text.length };
    });
    r.press('c');
    await settleWork();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('files');
    expect(copied[0]).not.toContain('\u001b');
    expect(copied[0]).not.toContain('[Ctrl+Y]');
  });

  it('a label with line and paragraph separators is one line of the copy through the real [c]: no row is forged, and the deep section has no age', async () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const forged = ['  ok  OS keychain  reachable', '  x failed  Anthropic  key rejected'];
    const copied: string[] = [];
    const r = await withMcpLabel(`files${LS}${forged[0]}${PS}${forged[1]}`, (text) => {
      copied.push(text);
      return { kind: 'written', characters: text.length };
    });
    // Time passes between the deep run and the copy: the age is read at the moment of the copy, and the copy carries none.
    r.clock.advance(5000);
    r.press('c');
    await settleWork();
    const text = copied.at(-1) ?? '';
    expect(copied).toHaveLength(1);
    expect(text).toContain('Deep check');
    expect(text).not.toContain(LS);
    expect(text).not.toContain(PS);
    expect(text).not.toMatch(/ago/u);
    expect(text.split('\n')).toContain('  Deep check');
    // Split on every separator a viewer might honour: the rows are the ones the report has, and neither forged row is one of them.
    const lines = text.split(new RegExp(`[\\n\\r${LS}${PS}]`, 'u'));
    for (const line of lines) expect(forged).not.toContain(line);
  });

  it('the detail step carries no key token from the label either', async () => {
    const r = await withMcpLabel('files [Ctrl+Y] send');
    for (let index = 0; index < 30; index += 1) {
      const frame = r.host.getSnapshot().frame;
      const content = r.content(DOCTOR_STEP.checks);
      if (frame === undefined || content.kind !== 'list') throw new Error('list');
      if (content.rows[frame.steps[0]?.selected ?? 0]?.id === 'deep:mcp:evil') break;
      r.press('', DOWN);
    }
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    expect(r.words()).toContain('files');
    expect(r.words()).not.toContain('[Ctrl+Y]');
  });
});

describe('the seams of the doctor, each pinned by the line of code that removes it', () => {
  /** Open the doctor with no key, let the quick tier land and open the provider-keys row (the last of the checks) on its detail step. */
  async function onProviderKeysDetail(
    extra: { readonly openRemedy?: DoctorPort['openRemedy'] },
    seam = stubResolver({ keys: {}, providers: {} }),
  ) {
    const r = doctorRig();
    r.open({ ...extra, probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('', { end: true });
    r.press('', ENTER);
    await settleWork();
    r.clock.advance(600);
    r.show();
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    return r;
  }

  it('with the provider popup’s seam unwired, the Home names /providers in words and offers no Enter, in the detail or in the legend', async () => {
    const r = await onProviderKeysDetail({});
    expect(r.words()).toContain('/providers');
    expect(r.words()).not.toMatch(/Enter/u);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(popupLegend(frame).items.some((item) => 'keys' in item && item.keys === 'Enter')).toBe(
      false,
    );
  });

  it('with the seam wired, Enter on the detail opens the remedy through it, with the popup’s own context, and nothing else does', async () => {
    const calls: unknown[] = [];
    const r = await onProviderKeysDetail({
      openRemedy: (remedy, context) => {
        calls.push([remedy, typeof context.close]);
        return true;
      },
    });
    expect(r.words()).toContain('Press Enter to open /providers');
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('open');
    expect(popupLegend(frame).items.some((item) => 'keys' in item && item.keys === 'Enter')).toBe(
      true,
    );
    expect(calls).toEqual([]);
    r.press('', ENTER);
    expect(calls).toEqual([[{ kind: 'providers' }, 'function']]);
  });

  it('a row that has no remedy opens nothing on Enter, even with the seam wired', async () => {
    const calls: unknown[] = [];
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    r.open({
      probes: stubProbes(seam.resolver),
      openRemedy: (remedy) => {
        calls.push(remedy);
        return true;
      },
    });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('', ENTER); // the first row (the keychain) is fine: its detail has no remedy
    await settleWork();
    r.clock.advance(600);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    r.press('', ENTER);
    expect(calls).toEqual([]);
  });

  it('closing the popup stops the key presence reads: nothing reads the keychain after Esc', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const original = seam.availability.getMockImplementation();
    let calls = 0;
    seam.availability.mockImplementation((id) => {
      calls += 1;
      // The person closes the popup while the second read runs.
      if (calls === 2) r.press('', ESC);
      return original === undefined
        ? { status: 'missing', keychainHealth: 'available' }
        : original(id);
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    r.clock.advance(600);
    await settleWork();
    expect(r.host.getSnapshot().open).toBe(false);
    expect(calls).toBe(2);
  });

  it('a presence read that throws is not a key: it is counted as one that could not be checked, and the line names no origin for it', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: {}, providers: {} });
    seam.availability.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    expect(r.words()).toContain('no provider has a key');
    expect(r.words()).toContain('could not be checked');
    expect(r.words()).not.toMatch(/providers have a key/u);
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    // Nothing could be read, so the line has nothing to name and says why: no origin, and nothing to answer.
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(r.content().kind).toBe('empty');
    expect(r.words()).toContain(
      'No provider’s key and endpoint could both be read, so nothing would be sent.',
    );
    expect(r.words()).not.toContain('https://');
  });

  it('a provider whose key could not be read is named as not contacted on the line, beside the one that was named', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const original = seam.availability.getMockImplementation();
    seam.availability.mockImplementation((id) => {
      if (id === 'openai') throw new Error('keychain locked');
      return original === undefined
        ? { status: 'missing', keychainHealth: 'available' }
        : original(id);
    });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(r.words()).toContain('https://api.anthropic.com');
    expect(r.words()).toContain(
      'Not contacted (its key or its endpoint could not be read): OpenAI.',
    );
  });

  it('while the keys are read the loading words say how far it is, one provider at a time', async () => {
    const r = doctorRig();
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const gates: (() => void)[] = [];
    const pause = (): Promise<void> => new Promise<void>((resolve) => gates.push(resolve));
    r.open({ probes: stubProbes(seam.resolver) }, false, pause);
    r.show();
    const release = async (): Promise<void> => {
      gates.shift()?.();
      await settleWork();
    };
    await release(); // the keychain
    await release(); // the configuration
    await release(); // the global artifacts
    await release(); // the first provider
    expect(r.words()).toContain('Checking provider keys (1 of 4)');
    await release(); // the second
    expect(r.words()).toContain('Checking provider keys (2 of 4)');
  });

  it('the detail of a deep row says which check it is from and how old, and that the key worked', async () => {
    const r = doctorRig();
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    r.clock.advance(900);
    ctrlY(r);
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    r.clock.advance(5000);
    r.press('', { end: true });
    r.press('', ENTER);
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    expect(r.words()).toContain('The key worked: the request was answered.');
    expect(r.words()).toContain('From the deep check, 5s ago.');
  });
});

describe('the line is offered only if the page that draws it can show it whole (ADR-0148 §7)', () => {
  /** Four keyed providers, two of them pointed at a custom endpoint of ~200 characters: a line of twelve rows. */
  function longEndpoints() {
    const origins = {
      openai: `https://${'a'.repeat(190)}.example`,
      deepseek: `https://${'b'.repeat(190)}.example`,
    };
    const anthropic = recordingProvider('anthropic');
    const openai = recordingProvider('openai');
    const deepseek = recordingProvider('deepseek');
    const gemini = recordingProvider('gemini');
    const seam = stubResolver({
      keys: { anthropic: KEY, openai: KEY, deepseek: KEY, gemini: KEY },
      providers: { anthropic, openai, deepseek, gemini },
      origins,
    });
    return { seam, origins, providers: [anthropic, openai, deepseek, gemini] };
  }

  it('in the overlay (17 rows) the twelve-row line is drawn whole and answered', async () => {
    const { seam, origins, providers } = longEndpoints();
    const r = doctorRig({ placement: 'overlay' });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    await arm(r);
    const content = r.content();
    if (content.kind !== 'report') throw new Error('report');
    expect(content.lines.length).toBeGreaterThan(10);
    expect(content.lines.length).toBeLessThanOrEqual(17);
    // Every origin is on the line whole (in lines that rejoin to it).
    const joined = content.lines.map((line) => line.trim()).join('');
    for (const origin of Object.values(origins)) expect(joined).toContain(origin);
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    expect(providers.map((provider) => provider.requests.length)).toEqual([1, 1, 1, 1]);
  });

  it('inline (10 rows) the same line is not offered: the sentence says so and what to do, and Ctrl+Y sends nothing and reads no key', async () => {
    const { seam, providers } = longEndpoints();
    const r = doctorRig({ placement: 'replace' });
    r.open({ probes: stubProbes(seam.resolver) });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(r.content()).toEqual({
      kind: 'empty',
      what: 'These destinations are too long to confirm here, so nothing is sent.',
      next: 'Shorten the custom addresses, or confirm them in full-screen mode, which has the rows to show them whole. Esc goes back.',
    });
    r.clock.advance(300);
    r.show();
    r.clock.advance(1000);
    ctrlY(r);
    await settleWork();
    for (const provider of providers) expect(provider.requests).toEqual([]);
    expect(seam.keyFor).not.toHaveBeenCalled();
  });
});
