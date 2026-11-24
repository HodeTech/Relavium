import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { MAX_HOME_NOTICE_CHARS, layoutHomeNotice } from './home-notice.js';

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
      await vi.waitFor(() => expect(controller.getSnapshot().palette?.state.query).toBe('doctor'));
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
        await vi.waitFor(() => expect(h.controller.getSnapshot().stripFocus?.id).toBe('saved-0'));
        h.resize(80, 24);
        await vi.waitFor(() => expect(h.frame('doctor:')).toContain('Notice 1–'));
        expect(h.frame('doctor:')).toContain('> Saved conversation 0');
        expect(h.frame('doctor:')).toContain('No provider key yet · Enter to connect');
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
      await vi.waitFor(() => expect(h.controller.getSnapshot().stripFocus?.id).toBe('saved-0'));
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
      await vi.waitFor(() => expect(h.controller.getSnapshot().stripFocus?.id).toBeUndefined());
      h.resize(80, 24);
      await vi.waitFor(() =>
        expect(h.frame('Saved conversation')).not.toContain('Terminal too small'),
      );
      h.input.push('\x1b[B');
      await vi.waitFor(() => expect(h.controller.getSnapshot().stripFocus?.id).toBe('saved-0'));
      h.input.push('\r');
      await vi.waitFor(() => expect(h.resumeChat).toHaveBeenCalledWith('saved-0'));
    } finally {
      await h.close();
    }
  });

  it('suspends hidden palette confirmation while keeping Esc and Ctrl+C available', async () => {
    const h = mount(alternate, false);
    try {
      await vi.waitFor(() => expect(h.output.frames.join('')).toContain('Saved conversation'));
      h.input.push('/');
      await vi.waitFor(() => expect(h.controller.getSnapshot().palette).toBeDefined());
      h.input.push('resume');
      await vi.waitFor(() =>
        expect(h.controller.getSnapshot().palette?.state.query).toBe('resume'),
      );
      h.resize(40, 24);
      await vi.waitFor(() => expect(h.frame('Terminal too small')).not.toBe(''));
      expect(h.frame('Terminal too small')).not.toContain('/resume');
      h.input.push('\r');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(h.pickSession).not.toHaveBeenCalled();
      h.input.push('\x1b');
      await vi.waitFor(() => expect(h.controller.getSnapshot().palette).toBeUndefined());
      // Ctrl+C is the first press of the two that leave the Home (ADR-0115 §1): it arms, the second one exits.
      h.input.push('\x03');
      await vi.waitFor(() => expect(h.controller.getSnapshot().interruptArmed).toBe(true));
      expect(h.onExit).not.toHaveBeenCalled();
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
    'This session belongs to another directory. Open Home there, or use /resume and Tab to browse all directories.';
  expect(layoutHomeNotice({ ...options, notice: remedy })?.lines.join('')).toBe(remedy);
});

describe('a notice is bounded before it is wrapped (review: a 2 MiB notice had no caller bound)', () => {
  const options = {
    editor: { text: '', cursor: 0 },
    cols: 80,
    rows: 24,
    keyless: false,
    showBanner: false,
    isEmpty: false,
    hasSessions: false,
  };

  /** Every page's lines, in order, and how many pages there are. */
  function pagesOf(notice: string): { readonly text: string; readonly pages: number } {
    const first = layoutHomeNotice({ ...options, notice });
    if (first === undefined) throw new Error('Missing report');
    const lines: string[] = [];
    for (let page = 0; page <= first.maxPage; page++) {
      lines.push(...(layoutHomeNotice({ ...options, notice, page })?.lines ?? []));
    }
    return { text: lines.join(''), pages: first.maxPage + 1 };
  }

  it('lays out megabytes of notice as its first pages and a closing ellipsis, not as every row of it', () => {
    const { text, pages } = pagesOf('word '.repeat(500_000)); // 2.5 million characters
    // Counted, not timed: the characters that reach the wrap are the bound plus the ellipsis (and a space the wrap swallows).
    expect(text.replace(/\s/gu, '').length).toBeLessThanOrEqual(MAX_HOME_NOTICE_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
    expect(pages).toBeLessThan(MAX_HOME_NOTICE_CHARS / 80);
  });

  it('shows a notice of exactly the bound whole and marks one character more as cut', () => {
    const exact = 'x'.repeat(MAX_HOME_NOTICE_CHARS);
    expect(pagesOf(exact).text).toBe(exact);
    const over = pagesOf(`${exact}y`).text;
    expect(over.endsWith('…')).toBe(true);
    expect(over).not.toContain('y');
  });

  it('never cuts a surrogate pair in two at the bound', () => {
    const notice = `${'a'.repeat(MAX_HOME_NOTICE_CHARS - 1)}\u{1F600}b`; // the pair straddles the bound
    const { text } = pagesOf(notice);
    expect(text).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
    );
    expect(text.endsWith('…')).toBe(true);
  });

  it('keeps a notice that is not over the bound exactly as it was', () => {
    expect(pagesOf('Open Home there.').text).toBe('Open Home there.');
  });
});

describe('a row that continues a line starts with its word, not with the wrap’s own space (MVP-11 Step 2 review, C9b)', () => {
  const options = {
    editor: { text: '', cursor: 0 },
    cols: 20,
    rows: 24,
    keyless: false,
    showBanner: false,
    isEmpty: false,
    hasSessions: false,
  };
  const linesOf = (notice: string): readonly string[] =>
    layoutHomeNotice({ ...options, notice })?.lines ?? [];

  it('drops the space a word ending on the last column leaves at the start of the next row', () => {
    // 20 characters, then the space, then the rest: the row is full, so the space used to open the next row (` opened; it is stored…`).
    expect(linesOf(`${'a'.repeat(20)} opened; it is stored`)).toEqual([
      'a'.repeat(20),
      'opened; it is stored',
    ]);
  });

  it('keeps a space the wrap leaves at the END of a row, and the indent of the first row of a line', () => {
    const rows = linesOf('  indented line that wraps here');
    expect(rows[0]?.startsWith('  indented')).toBe(true);
    expect(rows.slice(1).every((row) => !row.startsWith(' '))).toBe(true);
  });

  it('applies to every logical line, and never removes a character that is not whitespace', () => {
    const rows = linesOf(`${'b'.repeat(20)} first\n${'c'.repeat(20)} second`);
    expect(rows).toEqual(['b'.repeat(20), 'first', 'c'.repeat(20), 'second']);
  });
});
