import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { layoutHomeNotice } from './home-notice.js';

const snapshot: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: Array.from({ length: 8 }, (_, n) => ({
    sessionId: `saved-${n}`,
    title: `Saved conversation ${n}`,
    workingDir: '/workspace',
    agentSlug: 'chat',
    modelId: 'model',
    status: 'ended',
    updatedAt: '2026-11-10T00:00:00.000Z',
    totalCostMicrocents: 0,
  })),
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: Array.from({ length: 50 }, (_, n) => `run-${n}`),
  isEmpty: false,
};
const detail = 'Read this diagnostic detail carefully. '.repeat(80) + 'FINAL_RECOVERY_REMEDY';
function mount(alternate: boolean, color: boolean, keyless = false) {
  const input = new OwnedTtyInput(),
    output = new OwnedTtyOutput(),
    stderr = new OwnedTtyOutput();
  output.columns = 120;
  output.rows = 60;
  const startChat = vi.fn(() => Promise.reject(new Error('Unexpected chat build')));
  const resumeChat = vi.fn(() => Promise.resolve(undefined));
  const pickSession = vi.fn(() => Promise.resolve(undefined));
  const onExit = vi.fn();
  const controller = createHomeController({
    startChat,
    resumeChat,
    pickSession,
    homeStore: { read: () => snapshot },
    doctorProbes: {
      keychain: () => {},
      config: () => {},
      toolHost: {},
      globalArtifacts: () => detail,
    },
    providerSetup: { initialKeyless: keyless, open: () => Promise.resolve() },
    onExit,
    onError: (cause) => {
      throw cause;
    },
  });
  const mounted = render(
    createElement(RootApp, {
      controller,
      color,
      nowMs: () => 0,
      alternateScreen: alternate,
      getSize: () => ({ cols: output.columns, rows: output.rows }),
      subscribeResize: (listener) => {
        output.on('resize', listener);
        return () => {
          output.off('resize', listener);
        };
      },
    }),
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: alternate,
    },
  );
  return {
    input,
    output,
    controller,
    startChat,
    resumeChat,
    pickSession,
    onExit,
    frame: (marker: string) => output.frames.findLast((chunk) => chunk.includes(marker)) ?? '',
    resize: (cols: number, rows: number) => {
      output.columns = cols;
      output.rows = rows;
      output.emit('resize');
    },
    doctor: async () => {
      input.push('/');
      await vi.waitFor(() => expect(controller.getSnapshot().palette).toBeDefined());
      input.push('doctor');
      await vi.waitFor(() => expect(controller.getSnapshot().palette?.query).toBe('doctor'));
      input.push('\r');
    },
    close: async () => {
      await controller.teardownActive();
      mounted.unmount();
      await mounted.waitUntilExit();
      input.destroy();
      output.destroy();
      stderr.destroy();
    },
  };
}

describe.each([true, false])('Home reports and minimum geometry alternate=%s', (alternate) => {
  it.each([true, false])(
    'retains complete doctor output, wraps and pages without hiding Continue or the prompt (color=%s)',
    async (color) => {
      const h = mount(alternate, color, true);
      try {
        await vi.waitFor(() => expect(h.output.frames.join('')).toContain('Saved conversation'));
        await h.doctor();
        await vi.waitFor(() => expect(h.frame('doctor:')).toContain('FINAL_RECOVERY_REMEDY'));
        expect(h.frame('doctor:')).toContain('wired tools');
        h.input.push('\x1b[B');
        await vi.waitFor(() =>
          expect(h.controller.getSnapshot().continueSessionId).toBe('saved-0'),
        );
        h.resize(80, 24);
        await vi.waitFor(() => expect(h.frame('doctor:')).toContain('Notice 1–'));
        expect(h.frame('doctor:')).toContain('> Saved conversation 0');
        expect(h.frame('doctor:')).toContain('Connect a provider');
        expect(h.frame('doctor:')).toContain('PgUp/PgDn');
        expect(h.frame('doctor:').split('\n').length).toBeLessThanOrEqual(24);
        // Coalesced page keys reduce against the live page, without submitting or moving Continue focus.
        h.input.push('\x1b[6~'.repeat(20));
        await vi.waitFor(() => expect(h.frame('PgUp/PgDn')).toContain('FINAL_RECOVERY_REMEDY'));
        expect(h.controller.getSnapshot().input.text).toBe('');
        expect(h.resumeChat).not.toHaveBeenCalled();
        expect(h.startChat).not.toHaveBeenCalled();
        const rerunStart = h.output.frames.length;
        await h.doctor();
        await vi.waitFor(() =>
          expect(h.output.frames.slice(rerunStart).join('')).toContain('Notice 1–'),
        );
        h.resize(120, 60);
        await vi.waitFor(() => expect(h.frame('doctor:')).toContain('FINAL_RECOVERY_REMEDY'));
        expect(h.frame('doctor:')).not.toContain('PgUp/PgDn');
      } finally {
        await h.close();
      }
    },
  );

  it('blocks hidden Continue and pasted submission, preserving cancellation and recovery', async () => {
    const h = mount(alternate, false);
    try {
      h.resize(80, 24);
      await vi.waitFor(() => expect(h.output.frames.join('')).toContain('Saved conversation'));
      h.input.push('\x1b[B');
      await vi.waitFor(() => expect(h.controller.getSnapshot().continueSessionId).toBe('saved-0'));
      // Enter arrives before React can paint the resize: admission must read actual geometry.
      h.resize(40, 24);
      h.input.push('\r');
      await vi.waitFor(() => expect(h.frame('Terminal too small')).not.toBe(''));
      h.input.push('\x1b[200~HIDDEN PASTED PROMPT\x1b[201~\r');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(h.resumeChat).not.toHaveBeenCalled();
      expect(h.startChat).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().input.text).toBe('');
      h.input.push('\x1b');
      await vi.waitFor(() => expect(h.controller.getSnapshot().continueSessionId).toBeUndefined());
      h.resize(80, 24);
      await vi.waitFor(() =>
        expect(h.frame('Saved conversation')).not.toContain('Terminal too small'),
      );
      h.input.push('\x1b[B');
      await vi.waitFor(() => expect(h.controller.getSnapshot().continueSessionId).toBe('saved-0'));
      h.input.push('\r');
      await vi.waitFor(() => expect(h.resumeChat).toHaveBeenCalledWith('saved-0'));
    } finally {
      await h.close();
    }
  });

  it('suspends hidden palette confirmation while keeping Esc and Ctrl-C available', async () => {
    const h = mount(alternate, false);
    try {
      await vi.waitFor(() => expect(h.output.frames.join('')).toContain('Saved conversation'));
      h.input.push('/');
      await vi.waitFor(() => expect(h.controller.getSnapshot().palette).toBeDefined());
      h.input.push('resume');
      await vi.waitFor(() => expect(h.controller.getSnapshot().palette?.query).toBe('resume'));
      h.resize(40, 24);
      await vi.waitFor(() => expect(h.frame('Terminal too small')).not.toBe(''));
      expect(h.frame('Terminal too small')).not.toContain('/resume');
      h.input.push('\r');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(h.pickSession).not.toHaveBeenCalled();
      h.input.push('\x1b');
      await vi.waitFor(() => expect(h.controller.getSnapshot().palette).toBeUndefined());
      h.input.push('\x03');
      await vi.waitFor(() => expect(h.onExit).toHaveBeenCalledTimes(1));
    } finally {
      await h.close();
    }
  });
});

it('retains every diagnostic row across pages and the full long shell-picker remedy', () => {
  const options = {
    notice: Array.from(
      { length: 200 },
      (_, n) => `ROW-${String(n).padStart(3, '0')} ${'word '.repeat(20)}`,
    ).join('\n'),
    editor: { text: '', cursor: 0 },
    cols: 80,
    rows: 24,
    keyless: true,
    errorText: undefined,
    showBanner: false,
    isEmpty: false,
    hasSessions: true,
  };
  const first = layoutHomeNotice(options);
  if (first === undefined) throw new Error('Missing report');
  const text: string[] = [];
  for (let page = 0; page <= first.maxPage; page++) {
    const layout = layoutHomeNotice({ ...options, page });
    if (layout === undefined) throw new Error('Missing page');
    expect(layout.rowCount).toBeLessThanOrEqual(13);
    text.push(...layout.lines);
  }
  expect(new Set(text.join('\n').match(/ROW-\d{3}/gu)).size).toBe(200);
  const remedy =
    'This session belongs to another directory. Open Home there, or use relavium chat resume and Tab to browse all directories.';
  expect(layoutHomeNotice({ ...options, notice: remedy })?.lines.join('')).toBe(remedy);
});
