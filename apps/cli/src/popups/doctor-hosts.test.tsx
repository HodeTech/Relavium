// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * `/doctor` in the three hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8, MVP-11 §4.4): the Home, the chat the Home hosts and a stand-alone chat, each in both placements. What it pins: typing `/doctor` opens the
 * popup from the host's own routing (never through a submit, so the popup host's gate does not take the command's own line for a turn); nothing
 * reaches the Home's notice or the transcript; the deep tier is new on the Home and opens on its line; the inline block takes the same keys and
 * the same chord; and drawing the popup reads no keychain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeChatSession } from '../render/tui/home-controller.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { DOCTOR_STEP } from './doctor-popup.js';
import { openDoctor, type DoctorPort, type DoctorSurface } from './doctor-port.js';
import { recordingProvider, stubProbes, stubResolver } from './doctor.test-support.js';
import type { PopupHost } from './popup-host.js';

type Host = 'home' | 'chat' | 'standalone-chat';
type Mounted = HomeMount | ChatMount;

const KEY = ['sk', 'ant', 'hosts', 'ABCDEF1234567890'].join('-');
const HOSTS: readonly Host[] = ['home', 'chat', 'standalone-chat'];
const RENDERERS = ['alt', 'inline'] as const;

/**
 * How long a wait on a real host may take. Generous on purpose: a machine under load (a mutation sweep, a full gate beside it) takes seconds for
 * what takes milliseconds alone, and a wait for something that never comes fails by its own assertion when the time is up. The test's own timeout
 * is three times it, so no wait is cut short by the test that holds it.
 */
const WAIT_MS = 10_000;
vi.setConfig({ testTimeout: 3 * WAIT_MS });

afterEach(() => {
  vi.useRealTimers();
});

const surfaceOf = (host: Host): DoctorSurface => (host === 'chat' ? 'home-chat' : host);

/** The doctor's port and its seam, for a host. */
function doctorFor(host: Host) {
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  const probes = stubProbes(seam.resolver);
  const port: DoctorPort = {
    scope: {},
    surface: surfaceOf(host),
    resultKey: host === 'home' ? 'home' : 'session',
    probes,
  };
  return { anthropic, seam, probes, port };
}

/**
 * Mount `host` wired as `driveHome` and the chat driver wire it: the Home's controller opens the popup through `openDoctor` on its own popup
 * host, the in-Home chat's session carries its port, and the stand-alone chat gets its port as a prop.
 */
async function mountWithDoctor(host: Host, variant: Variant, port: DoctorPort): Promise<Mounted> {
  const wired: { popups: PopupHost | undefined } = { popups: undefined };
  const openDoctorOn = ({
    deep,
    chat,
  }: {
    readonly deep: boolean;
    readonly chat?: DoctorPort | undefined;
  }): void => {
    const host = wired.popups;
    if (host === undefined) return;
    void openDoctor({
      host,
      port: chat ?? port,
      deep,
      origin: chat === undefined ? 'home' : 'chat',
    });
  };
  let mounted: Mounted;
  if (host === 'home') mounted = mountHome(variant, { deps: { openDoctor: openDoctorOn } });
  else if (host === 'chat') {
    const session: Partial<Omit<HomeChatSession, 'store'>> = { doctor: port };
    mounted = await mountHostedChat(variant, {
      hosted: { home: { deps: { openDoctor: openDoctorOn } }, session },
    });
  } else mounted = mountStandaloneChat(variant, { standalone: { doctor: port } });
  wired.popups = mounted.popups;
  await mounted.settle();
  return mounted;
}

/** Type a line the way a person does in this host (a pasted line, then Enter: a lone `/` would open the palette). */
async function typeLine(m: Mounted, line: string): Promise<void> {
  if ('typeLine' in m) {
    await m.typeLine(line);
    return;
  }
  m.key(`\u001b[200~${line}\u001b[201~`);
  await m.until(() => m.controller.getSnapshot().input.text === line);
  m.key(KEYS.enter);
  await m.settle();
}

const doctorStep = (m: Mounted): number | undefined =>
  m.popups.getSnapshot().frame?.spec.id === 'doctor'
    ? m.popups.getSnapshot().frame?.stepIndex
    : undefined;

describe.each(HOSTS)('/doctor in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };

    it('opens the popup from the host’s routing, and writes nothing into the Home’s notice or the transcript', async () => {
      const { port } = doctorFor(host);
      const m = await mountWithDoctor(host, variant, port);
      try {
        const transcript = 'store' in m ? m.store.getSnapshot().state.transcript : undefined;
        const notice = 'controller' in m ? m.controller.getSnapshot().notice : undefined;
        await typeLine(m, '/doctor');
        await m.until(() => m.frame().join('\n').includes('doctor: all checks passed'));
        expect(doctorStep(m)).toBe(DOCTOR_STEP.checks);
        expect(m.frame().join('\n')).toContain('/doctor');
        // The line never reached the chat's dispatch (it would have printed the text report into the transcript).
        if ('submitted' in m) expect(m.submitted).toEqual([]);
        if ('store' in m) expect(m.store.getSnapshot().state.transcript).toBe(transcript);
        if ('controller' in m) expect(m.controller.getSnapshot().notice).toBe(notice);
        m.key(KEYS.escape);
        await vi.waitFor(() => expect(m.popups.getSnapshot().open).toBe(false), {
          timeout: WAIT_MS,
          interval: 15,
        });
        if ('store' in m) expect(m.store.getSnapshot().state.transcript).toBe(transcript);
        if ('controller' in m) expect(m.controller.getSnapshot().notice).toBe(notice);
      } finally {
        m.unmount();
      }
    });

    it('`/doctor --deep` opens the popup on its confirmation line, which names the origin that would receive the key', async () => {
      const { port } = doctorFor(host);
      const m = await mountWithDoctor(host, variant, port);
      try {
        await typeLine(m, '/doctor --deep');
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        expect(doctorStep(m)).toBe(DOCTOR_STEP.line);
        expect(m.frame().join('\n')).toContain(
          'Sends one small request per provider, with its key, to:',
        );
      } finally {
        m.unmount();
      }
    });
  });
});

describe('another argument on the Home', () => {
  it('is refused in one line that names the one /doctor takes, and opens nothing', async () => {
    const { port } = doctorFor('home');
    const m = await mountWithDoctor(
      'home',
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      port,
    );
    try {
      if (!('controller' in m)) throw new Error('the Home');
      await typeLine(m, '/doctor --verbose');
      await m.until(() => m.controller.getSnapshot().notice !== undefined);
      expect(m.controller.getSnapshot().notice).toBe('/doctor accepts only --deep.');
      expect(m.popups.getSnapshot().open).toBe(false);
    } finally {
      m.unmount();
    }
  });
});

describe('a typed palette line opens the popup as the same line at the prompt does', () => {
  it.each(['chat', 'standalone-chat'] as const)(
    '%s: `/doctor --deep` typed into the palette opens the popup on its line, and reaches neither the dispatch nor the transcript',
    async (host) => {
      const { port } = doctorFor(host);
      const m = await mountWithDoctor(
        host,
        { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
        port,
      );
      try {
        const transcript = 'store' in m ? m.store.getSnapshot().state.transcript : undefined;
        m.key('/');
        await m.settle();
        m.key('doctor --deep');
        await m.settle();
        m.key(KEYS.enter);
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        expect(doctorStep(m)).toBe(DOCTOR_STEP.line);
        if ('submitted' in m) expect(m.submitted).toEqual([]);
        if ('store' in m) expect(m.store.getSnapshot().state.transcript).toBe(transcript);
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the deep tier through a real host, both placements (ADR-0148 §4, §8)', () => {
  it.each(RENDERERS)(
    '%s: [d] arms the line, Ctrl+Y after the dwell sends, Esc closes',
    async (renderer) => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const { port, anthropic } = doctorFor('home');
      const m = await mountWithDoctor('home', variant, port);
      try {
        await typeLine(m, '/doctor');
        await m.until(() => m.frame().join('\n').includes('doctor: all checks passed'));
        vi.advanceTimersByTime(600);
        m.key('d');
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        await m.settle();
        // Too soon: the dwell counts from the line's acknowledged frame.
        vi.advanceTimersByTime(300);
        m.key(KEYS.ctrlY);
        await m.settle();
        expect(anthropic.requests).toHaveLength(0);
        expect(doctorStep(m)).toBe(DOCTOR_STEP.checks);
        // Armed again, and answered after the dwell (and past the lockout of the refused press).
        vi.advanceTimersByTime(2100);
        m.key('d');
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        await m.settle();
        vi.advanceTimersByTime(900);
        m.key(KEYS.ctrlY);
        await vi.waitFor(() => expect(anthropic.requests).toHaveLength(1));
        await m.until(() => m.frame().join('\n').includes('Deep check'));
        m.key(KEYS.escape);
        await vi.waitFor(() => expect(m.popups.getSnapshot().open).toBe(false), {
          timeout: WAIT_MS,
          interval: 15,
        });
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the popup opens before the line is a submit (the open item of part 4.1)', () => {
  it('a stand-alone chat opens it although a submit in flight would have refused it', async () => {
    const { port } = doctorFor('standalone-chat');
    // A chat whose submits never settle: a line that WENT through the submit would hold `submitBusy` true, and the gate would refuse the popup.
    const m = mountStandaloneChat(
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      { standalone: { doctor: port, onSubmit: () => new Promise<void>(() => {}) } },
    );
    try {
      await m.settle();
      await m.typeLine('/doctor');
      await m.until(() => m.popups.getSnapshot().open);
      expect(m.popups.getSnapshot().frame?.spec.id).toBe('doctor');
      expect(m.notifications.getSnapshot().current?.text ?? '').not.toContain('cannot open');
    } finally {
      m.unmount();
    }
  });
});

describe('drawing the popup reads no keychain (ADR-0148 §8)', () => {
  it('every presence read and the keychain probe run in the work; renders, moves and resizes after it read nothing', async () => {
    const { port, seam, probes } = doctorFor('home');
    const m = await mountWithDoctor(
      'home',
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      port,
    );
    try {
      await typeLine(m, '/doctor');
      await m.until(() => m.frame().join('\n').includes('doctor: all checks passed'));
      const reads = seam.availability.mock.calls.length;
      const probed = probes.keychainReads();
      expect(reads).toBe(4);
      expect(probed).toBe(1);
      for (let frame = 0; frame < 5; frame += 1) {
        m.key(KEYS.down);
        await m.settle();
        m.notifications.notify(`frame ${String(frame)}`);
        await m.settle();
      }
      expect(seam.availability.mock.calls.length).toBe(reads);
      expect(probes.keychainReads()).toBe(probed);
      expect(seam.keyFor).not.toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });
});
