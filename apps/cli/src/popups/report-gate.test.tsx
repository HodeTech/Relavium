// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The open gate of the hosts reads the same facts the release re-checks ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): a turn streaming, a submit settling (the auto-compaction after a turn) and a `!` command running each refuse a report popup, in the chat
 * the Home hosts and in a stand-alone chat, and the answer of a release asks the host's own state for each of them at the moment it is given.
 * The gate and the answer share one predicate (`turn-in-flight.ts`), so a fact dropped from a host's reading is dropped from both: each test
 * here starts one kind of work in the real host and sees the popup refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS } from '../render/tui/surface-matrix/home-host.js';
import { reportsPortFor } from '../render/tui/surface-matrix/report-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { openReport } from './report-port.js';

const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

afterEach(() => {
  vi.useRealTimers();
});

type Work = 'submit' | 'shell';
type Host = 'chat' | 'standalone-chat';

/** A host whose chat is busy with `work` that never ends: a message submit, or a `!` command. */
async function mountBusy(host: Host, work: Work): Promise<ChatMount> {
  const never = () => new Promise<never>(() => {});
  const ports = {
    // The Home's chat starts on a first message, which settles; every line after it never does.
    ...(work === 'shell' ? { runShellCommand: never } : {}),
  };
  let lines = 0;
  const m =
    host === 'chat'
      ? await mountHostedChat(VARIANT, {
          reports: reportsPortFor('home-chat', 'cost-held'),
          hosted: {
            session: {
              ...ports,
              processLine: () =>
                lines++ === 0 ? Promise.resolve() : never().then(() => undefined),
            },
          },
        })
      : mountStandaloneChat(VARIANT, {
          reports: reportsPortFor('standalone-chat', 'cost-held'),
          standalone: { ...ports, ...(work === 'submit' ? { onSubmit: never } : {}) },
        });
  await m.settle();
  return m;
}

/** What the popup host says to a report asked for now. */
async function askNow(m: ChatMount): Promise<void> {
  await openReport({
    host: m.popups,
    port: reportsPortFor('standalone-chat', 'cost-held'),
    line: { kind: 'cost', release: false },
    origin: 'chat',
    turnInFlight: () => false,
  });
}

describe.each(['chat', 'standalone-chat'] as const)('the open gate of the %s host', (host) => {
  it.each(['submit', 'shell'] as const)(
    'refuses a report while a %s is in flight',
    async (work) => {
      const m = await mountBusy(host, work);
      try {
        // Start the work the way a person does, and wait until the host has taken it on.
        if (work === 'submit') {
          m.key('hello');
          await m.settle();
          m.key(KEYS.enter);
        } else {
          m.key('!sleep');
          await m.settle();
          m.key(KEYS.enter);
        }
        await m.settle();
        await askNow(m);
        expect(m.popups.getSnapshot().open).toBe(false);
        const notified = m.notifications.getSnapshot();
        expect((notified.current === undefined ? 0 : 1) + notified.queued).toBe(1);
      } finally {
        m.unmount();
      }
    },
  );

  it('opens it when nothing is in flight (the same call, no work started)', async () => {
    const m = await mountBusy(host, 'submit');
    try {
      await askNow(m);
      expect(m.popups.getSnapshot().frame?.spec.id).toBe('cost');
    } finally {
      m.unmount();
    }
  });
});
