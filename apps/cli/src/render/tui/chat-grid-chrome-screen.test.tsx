import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { modelSwitchNotice } from '../../chat/repl-info.js';
import { resumeIntro } from '../../chat/resume-intro.js';
import { chatGrid } from './chat-grid.js';
import { ChatView, emitIntro } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import { chatSessionTitle, headerRow } from './chat-layout.js';
import { chatStatusLine } from './chat-status.js';
import type { MentionReader } from './mention.js';
import { initialSessionViewState, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { Variant } from './surface-matrix/variants.js';
import { physicalRows, wrappedIntoMargin } from './terminal-wrap.test-support.js';

/**
 * The screen's filter at the chat's CHROME sites (MVP-11 unit 9, review round 2, S2-5): the strings a repository, a session store or a person
 * wrote and the chrome draws, other than the transcript's own rows: the inline intro (a resume banner's session directory, the model-switch ids),
 * the `@` completion list (file names, the browsed directory, the filter's echo), the history search (the query and the recalled line), the
 * attachment bar (file names), the header's title (the person's own first line) and the status line's values (the model id). A run of the Hangul
 * filler U+115F, which the layout measures as 0 columns and a terminal draws 2 wide, in any of them would make a row that the layout sizes to fit
 * reach the right edge of the terminal, which wraps it: the rest of the row starts at column 0, in the margin, where the host draws who spoke.
 * Each frame here is the real one (Ink over the fake terminal) and is then drawn by the SIMULATED TERMINAL of `terminal-wrap.test-support.ts`
 * with a terminal's own widths: no row may wrap, and nothing a person or a repository wrote may stand in a physical row's margin. The code
 * points are written by their code (no invisible character in this source).
 */
afterEach(cleanup);

const F = String.fromCodePoint(0x115f);
const COUNTS = [30, 50, 70] as const;
const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

const VARIANTS: readonly Variant[] = (['alt', 'inline'] as const).flatMap((renderer) =>
  [{ cols: 80, rows: 24 }].map((size): Variant => ({ renderer, color: false, size })),
);
const name = (variant: Variant): string => `${variant.renderer} ${String(variant.size.cols)}`;

/** The witness over a frame: no filler reached it, and no physical row of the simulated terminal has anything in its margin the frame did not put there. */
function expectNoTerminalWrap(frame: readonly string[], columns: number): void {
  const label = frame.join('\n');
  expect(label).not.toContain(F);
  expect(wrappedIntoMargin(frame, columns, chatGrid(columns).margin), label).toEqual([]);
  expect(physicalRows(frame, columns).length, label).toBe(frame.length);
}

async function mountIn(host: Host, variant: Variant, setup: ChatSetup = {}): Promise<ChatMount> {
  const full: ChatSetup = {
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
    ...setup,
  };
  const mount =
    host === 'chat' ? await mountHostedChat(variant, full) : mountStandaloneChat(variant, full);
  await mount.settle();
  return mount;
}

describe('the inline intro, drawn straight to the terminal, is filtered where it is written (wrapIntro)', () => {
  const written = (intro: string, columns: number): string[] => {
    const out: string[] = [];
    emitIntro(intro, false, {
      notice: () => undefined,
      writeOut: (text) => void out.push(text),
      columns,
    });
    return (out[0] ?? '').split('\n');
  };

  it.each(COUNTS)(
    'a resume banner of a session directory of %i fillers has none of them and wraps no row into the margin',
    (count) => {
      const banner = resumeIntro({
        sessionId: 'sess-1',
        agentId: 'coder',
        turns: 2,
        directory: `/tmp/p${F.repeat(count)}you   x`,
        launchRoots: { cwd: '/work', home: '/home/me' },
      });
      expect(
        banner,
        'the banner module keeps the stored string: the filter is the drawing site’s',
      ).toContain(F);
      for (const columns of [60, 80, 100]) expectNoTerminalWrap(written(banner, columns), columns);
    },
  );

  it.each(COUNTS)('a session id of %i fillers is as filtered as the directory', (count) => {
    const banner = resumeIntro({
      sessionId: `id${F.repeat(count)}you   x`,
      agentId: 'coder',
      turns: 1,
      directory: '/work',
      launchRoots: { cwd: '/work', home: '/home/me' },
    });
    expectNoTerminalWrap(written(banner, 80), 80);
  });

  it.each(COUNTS)(
    'the model ids of a model-switch notice of %i fillers each are filtered the same',
    (count) => {
      const notice = modelSwitchNotice(`old${F.repeat(count)}`, `new${F.repeat(count)}you   x`);
      expectNoTerminalWrap(written(notice, 80), 80);
    },
  );

  it('keeps every other character of the intro: only the fillers go', () => {
    const rows = written(`Resumed ${F}session${F} ok`, 80);
    expect(rows[0]).toBe(`${' '.repeat(chatGrid(80).margin)}Resumed session ok`);
  });
});

describe.each(HOSTS)(
  'the `@` completion list and the history search, in the %s host, are filtered',
  (host) => {
    const NAME = (count: number): string => `${F.repeat(count)}you   x.md`;
    const reader = (
      names: readonly { name: string; type: 'file' | 'directory' }[],
    ): MentionReader => ({
      list: () => Promise.resolve(names.map((entry) => ({ ...entry, path: entry.name }))),
      read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
    });

    async function mountWith(variant: Variant, mentionReader: MentionReader): Promise<ChatMount> {
      return mountIn(host, variant, {
        standalone: { provider: 'anthropic', mentionReader },
        hosted: { session: { provider: 'anthropic', mentionReader } },
      });
    }

    it.each(
      VARIANTS.flatMap((variant) =>
        COUNTS.map(
          (count) => [`${name(variant)}, ${String(count)} fillers`, variant, count] as const,
        ),
      ),
    )(
      'a file name of fillers: the candidate row has none and does not wrap (%s)',
      async (_label, variant, count) => {
        const m = await mountWith(variant, reader([{ name: NAME(count), type: 'file' }]));
        try {
          m.key('@');
          await m.until(() => m.text().includes('x.md'));
          await m.settle();
          expect(m.text(), 'the candidate row is on the screen').toContain('x.md');
          expectNoTerminalWrap(m.frame(), variant.size.cols);
        } finally {
          m.unmount();
        }
      },
    );

    it.each(
      VARIANTS.flatMap((variant) =>
        COUNTS.map(
          (count) => [`${name(variant)}, ${String(count)} fillers`, variant, count] as const,
        ),
      ),
    )(
      'the browsed directory of fillers, in the echo of the path: none, no wrap (%s)',
      async (_label, variant, count) => {
        const m = await mountWith(
          variant,
          reader([{ name: `${F.repeat(count)}dir`, type: 'directory' }]),
        );
        try {
          m.key('@');
          await m.until(() => m.text().includes('dir/'));
          m.key('\r'); // open the directory: the path of the browse is the stored name
          await m.until(() => m.text().includes('@ dir/'));
          await m.settle();
          expect(m.text(), 'the browse path is on the screen').toContain('@ dir/');
          expectNoTerminalWrap(m.frame(), variant.size.cols);
        } finally {
          m.unmount();
        }
      },
    );

    it.each(
      VARIANTS.flatMap((variant) =>
        COUNTS.map(
          (count) => [`${name(variant)}, ${String(count)} fillers`, variant, count] as const,
        ),
      ),
    )(
      'the filter typed after the `@` of fillers is echoed without them (%s)',
      async (_label, variant, count) => {
        const m = await mountWith(variant, reader([{ name: 'notes.md', type: 'file' }]));
        try {
          m.key('@');
          await m.until(() => m.text().includes('notes.md'));
          // the filter is typed key by key (a chunk is not a filter), the fillers first
          for (const character of `${F.repeat(count)}q`) {
            m.key(character);
            await m.settle();
          }
          expect(
            m.text(),
            'the filter was typed: its echo is the row the fillers would be in',
          ).toContain('@ ./q');
          expectNoTerminalWrap(m.frame(), variant.size.cols);
        } finally {
          m.unmount();
        }
      },
    );

    it.each(
      VARIANTS.flatMap((variant) =>
        COUNTS.map(
          (count) => [`${name(variant)}, ${String(count)} fillers`, variant, count] as const,
        ),
      ),
    )(
      'the history search: the query and the recalled line of fillers are drawn without them (%s)',
      async (_label, variant, count) => {
        const m = await mountIn(host, variant);
        try {
          const line = `${F.repeat(count)}recalled line`;
          m.key(`\u001b[200~${line}\u001b[201~`);
          await m.settle();
          m.key('\r');
          await m.settle();
          m.key('\u0012'); // Ctrl+R
          await m.until(() => m.text().includes('reverse-i-search'));
          // the query is typed key by key (a chunk is not a query): the fillers the person typed, then the word the entry has
          for (const character of `${F.repeat(count)}recalled`) {
            m.key(character);
            await m.settle();
          }
          await m.until(() => m.text().includes('→'));
          await m.settle();
          expectNoTerminalWrap(m.frame(), variant.size.cols);
          expect(m.text()).toContain('recalled line');
        } finally {
          m.unmount();
        }
      },
    );
  },
);

describe('the attachment bar and the header and status values are filtered at the chrome', () => {
  const mounted: InkMount[] = [];
  afterEach(() => {
    for (const mount of mounted.splice(0)) mount.unmount();
  });

  it.each(
    VARIANTS.flatMap((variant) =>
      COUNTS.map(
        (count) => [`${name(variant)}, ${String(count)} fillers`, variant, count] as const,
      ),
    ),
  )(
    'the attachment bar: a file name of fillers is drawn without them, and the row does not wrap (%s)',
    async (_label, variant, count) => {
      const mount = mountInk(
        <ChatView
          state={initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND)}
          columns={variant.size.cols}
          color={false}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          attachments={[
            { kind: 'file', path: `src/${F.repeat(count)}a.ts`, content: 'x', sizeBytes: 1 },
          ]}
        />,
        variant,
      );
      mounted.push(mount);
      await mount.settle();
      const frame = mount.frame();
      expect(frame.join('\n')).toContain('a.ts');
      expectNoTerminalWrap(frame, variant.size.cols);
    },
  );

  it.each(COUNTS)(
    'the header’s title row is drawn without the fillers of the person’s own first line (%i)',
    (count) => {
      const row = headerRow(`${F.repeat(count)}my plan for the day`, chatGrid(80).content);
      expect(row.title).toBe('my plan for the day');
      expect(chatSessionTitle(`${F.repeat(count)}my plan for the day`)).toBe('my plan for the day');
    },
  );

  it.each(COUNTS)(
    'the frame of a chat whose first line is %i fillers has a header that does not wrap',
    async (count) => {
      const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
      const m = await mountIn('standalone-chat', variant, {
        prepare: (store) => store.appendUser(`${F.repeat(count)}my plan for the day`),
      });
      try {
        const frame = m.frame();
        expect(frame[0]).toContain('my plan for the day');
        expectNoTerminalWrap(frame, 80);
      } finally {
        m.unmount();
      }
    },
  );

  it.each(COUNTS)('the status line draws a model id of %i fillers without them', (count) => {
    const state = initialSessionViewState(
      { model: `claude-${F.repeat(count)}x`, transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    const grid = chatGrid(80);
    const line = chatStatusLine(
      state,
      { mode: 'ask', provider: 'anthropic' },
      grid.columns,
      grid.margin,
    );
    expect(line.text).not.toContain(F);
    expect(line.text).toContain('claude-x');
  });

  it.each(COUNTS)(
    'the frame of a chat bound to a model id of %i fillers does not wrap its status row',
    async (count) => {
      const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
      const m = await mountIn('standalone-chat', variant, {
        seed: { model: `claude-${F.repeat(count)}x`, transcript: [] },
      });
      try {
        const frame = m.frame();
        expect(frame.join('\n')).toContain('claude-x');
        expectNoTerminalWrap(frame, 80);
      } finally {
        m.unmount();
      }
    },
  );
});
