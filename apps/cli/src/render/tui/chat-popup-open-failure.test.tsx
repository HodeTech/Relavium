/**
 * A popup's code is loaded the first time it is asked for (ADR-0148 §8, §10), and in a stand-alone chat a load that fails is the chat's own
 * fault: it reaches `onError` (which tears the chat down and reports), never a handler that swallows it. The chat's one open adapter routes
 * `/doctor` (and `--deep`) and the reports; each is driven here with its loader rejecting, and once with it loading as it does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDoctor } from '../../popups/doctor-port.js';
import { openReport } from '../../popups/report-port.js';
import { mountStandaloneChat } from './surface-matrix/chat-host.js';
import { doctorPortFor } from './surface-matrix/doctor-fixture.js';
import { reportsPortFor } from './surface-matrix/report-fixture.js';
import type { Variant } from './surface-matrix/variants.js';

vi.mock('../../popups/doctor-port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../popups/doctor-port.js')>();
  return { ...actual, openDoctor: vi.fn(actual.openDoctor) };
});
vi.mock('../../popups/report-port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../popups/report-port.js')>();
  return { ...actual, openReport: vi.fn(actual.openReport) };
});

const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

afterEach(() => {
  vi.mocked(openDoctor).mockClear();
  vi.mocked(openReport).mockClear();
});

function mount(onError: (cause: unknown) => void) {
  return mountStandaloneChat(VARIANT, {
    doctor: doctorPortFor('standalone-chat', 'keyed'),
    reports: reportsPortFor('standalone-chat', 'help'),
    standalone: { onError },
  });
}

describe('a popup whose code cannot load is the stand-alone chat’s own fault', () => {
  it.each([
    ['/doctor', 'doctor'],
    ['/doctor --deep', 'doctor'],
    ['/help', 'report'],
    ['/cost --release', 'report'],
  ] as const)('%s: the rejection reaches onError, once, with its cause', async (line, loader) => {
    const cause = new Error(`the code of ${line} could not be loaded`);
    vi.mocked(loader === 'doctor' ? openDoctor : openReport).mockRejectedValueOnce(cause);
    const onError = vi.fn();
    const m = mount(onError);
    try {
      await m.settle();
      await m.typeLine(line);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError).toHaveBeenCalledWith(cause);
      expect(vi.mocked(loader === 'doctor' ? openDoctor : openReport)).toHaveBeenCalledTimes(1);
      // The line was the popup's: it was never dispatched to the session.
      expect(m.submitted).toEqual([]);
      expect(m.popups.getSnapshot().open).toBe(false);
    } finally {
      m.unmount();
    }
  });

  it('the control: a loader that loads opens the popup and reports nothing', async () => {
    const onError = vi.fn();
    const m = mount(onError);
    try {
      await m.settle();
      await m.typeLine('/help');
      await vi.waitFor(() => expect(m.popups.getSnapshot().frame?.spec.id).toBe('help'));
      expect(onError).not.toHaveBeenCalled();
    } finally {
      m.unmount();
    }
  });
});
