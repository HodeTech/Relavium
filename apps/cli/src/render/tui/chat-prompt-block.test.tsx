import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { ChatView, idleHint, runningHint } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { displayWidth } from './viewport.js';

/**
 * The prompt block of a chat, in both hosts ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2 and §4, MVP-11 step 7a): a leading row, the prompt, a thin rule, ONE status line and the hint, in that order; the hint names where the second
 * `Ctrl+C` leads (the Home in the chat the Home hosts, the end of a stand-alone chat) and says only what is true in the state the chat is in; while
 * a turn runs the in-flight turn stands where the prompt is and the rest stays; a warning or the copy confirmation takes the leading row.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

const alt = (cols: number, rows: number, color = false): Variant => ({
  renderer: 'alt',
  color,
  size: { cols, rows },
});
const ALT_80 = alt(80, 24);

const CTRL_C = '\u0003';

const LEAVES: Readonly<Record<Host, { readonly twice: string; readonly again: string }>> = {
  'standalone-chat': { twice: 'end (twice)', again: 'end the session (again)' },
  chat: { twice: 'back to Home (twice)', again: 'back to Home (again)' },
};

function setupWith(over: ChatSetup = {}): ChatSetup {
  return {
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
    ...over,
  };
}

async function mountIn(
  host: Host,
  variant: Variant,
  setup: ChatSetup = setupWith(),
): Promise<ChatMount> {
  const mount =
    host === 'chat' ? await mountHostedChat(variant, setup) : mountStandaloneChat(variant, setup);
  await mount.settle();
  return mount;
}

const turnStarted = {
  type: 'session:turn_started' as const,
  sessionId: 'matrix-session',
  sequenceNumber: 1,
  timestamp: '2026-11-26T00:00:00.000Z',
};

/**
 * The chat's chrome stands on the grid (unit 9: the content column starts where the Home's wordmark starts): a row of the prompt block begins
 * `margin` columns from the left edge, 6 at 80 columns and 8 from 100.
 */
const indent = (cols: number, text: string): string =>
  `${' '.repeat(chatGrid(cols).margin)}${text}`;

/** The index of the thin rule: the one row made only of the margin and rule glyphs. */
const ruleAt = (rows: readonly string[]): number => rows.findIndex((row) => /^ +[-─]+$/u.test(row));

describe.each(HOSTS)('the prompt block, in the %s host', (host) => {
  it('is a blank row, the prompt, a thin rule, the status line and the hint, in that order, with the rule as wide as the content column', async () => {
    for (const cols of [80, 100]) {
      const m = await mountIn(
        host,
        alt(cols, 30),
        setupWith({ prepare: (s) => s.appendUser('hi') }),
      );
      try {
        const rows = m.frame();
        const shown = rows.join('\n');
        const at = ruleAt(rows);
        expect(at, shown).toBeGreaterThan(0);
        // The rule is the content column's width (68 at 80 columns, 84 at 100), not the terminal's.
        expect(rows[at], shown).toBe(indent(cols, '-'.repeat(chatGrid(cols).content)));
        expect(rows[at - 2]?.trim(), `${shown}\n(the blank row above the prompt)`).toBe('');
        expect(rows[at - 1], shown).toBe(indent(cols, '> reply to continue'));
        expect(rows[at + 1], shown).toContain(' · ask mode · ');
        expect(rows[at + 1]?.startsWith(indent(cols, 'anthropic')), shown).toBe(true);
        expect(rows[at + 2], shown).toMatch(
          new RegExp(`^ {${chatGrid(cols).margin}}\\[/\\] commands · \\[Ctrl\\+C\\] `, 'u'),
        );
        expect(rows.length, 'the hint is the last row of the frame').toBe(at + 3);
      } finally {
        m.unmount();
      }
    }
  });

  it('draws the prompt’s glyph, the rule and the markers with their Unicode forms when colour is on, and ASCII without it', async () => {
    const coloured = await mountIn(
      host,
      alt(80, 24, true),
      setupWith({ prepare: (s) => s.appendUser('hi') }),
    );
    try {
      const rows = coloured.frame();
      expect(rows[ruleAt(rows)]).toBe(indent(80, '─'.repeat(chatGrid(80).content)));
      expect(rows[ruleAt(rows) - 1]?.startsWith(indent(80, '› reply to continue'))).toBe(true);
    } finally {
      coloured.unmount();
    }
  });

  it.each([80, 100, 120])(
    'has ONE status line at %s columns in the usage-unknown state: provider first, never wrapped, the mode written as `<mode> mode`',
    async (cols) => {
      const m = await mountIn(
        host,
        alt(cols, 30),
        setupWith({
          seed: { model: 'claude-sonnet-4-6-20251101-extended', turnCount: 1234, transcript: [] },
          prepare: (store) => {
            store.setReasoningEffort('high');
            store.appendUser('hi');
          },
        }),
      );
      try {
        const rows = m.frame();
        const shown = rows.join('\n');
        const at = ruleAt(rows);
        const status = rows[at + 1] ?? '';
        expect(status.startsWith(indent(cols, 'anthropic · ')), shown).toBe(true);
        expect(status, shown).toContain(' · ask mode · effort high');
        expect(status, `the cost is never dropped: ${shown}`).toMatch(/\$[\d,.]+ known/u);
        // The line is fitted to what the terminal leaves right of the margin (the Home's budget).
        expect(displayWidth(status), shown).toBeLessThanOrEqual(cols);
        // One row: the next row is the hint, and the whole block is still five rows tall.
        expect(rows[at + 2]?.startsWith(indent(cols, '[/] commands')), shown).toBe(true);
        expect(rows.length - (at - 2), 'the prompt block at rest').toBe(5);
        expect(
          rows.filter((row) => row.includes(' · ask mode · ')),
          shown,
        ).toHaveLength(1);
      } finally {
        m.unmount();
      }
    },
  );

  it('says where the second Ctrl+C leads: the Home in the chat the Home hosts, the end of a stand-alone chat', async () => {
    const m = await mountIn(host, ALT_80);
    try {
      const hint = m.frame().at(-1);
      expect(hint).toBe(indent(80, `[/] commands · [Ctrl+C] ${LEAVES[host].twice}`));
      if (host === 'chat') expect(m.text()).not.toContain('end (twice)');
      else expect(m.text()).not.toContain('Home (twice)');
    } finally {
      m.unmount();
    }
  });

  it('says what the first Ctrl+C did: armed, the hint asks for the second one, in the host’s words', async () => {
    const m = await mountIn(host, ALT_80);
    try {
      m.key(CTRL_C);
      await m.until(() => m.frame().at(-1) === indent(80, `[Ctrl+C] ${LEAVES[host].again}`));
      expect(m.frame().at(-1)).toBe(indent(80, `[Ctrl+C] ${LEAVES[host].again}`));
    } finally {
      m.unmount();
    }
  });

  it('is the draft’s own hint once there is a draft: a hint that said `back to Home` there would be false, the first Ctrl+C clears the draft', async () => {
    const m = await mountIn(host, ALT_80);
    try {
      m.key('draft');
      await m.until(() => m.frame().at(-1)?.trimStart().startsWith('Enter send') === true);
      expect(m.frame().at(-1)).toBe(
        indent(80, 'Enter send · [Ctrl+J] newline · [Ctrl+C] clear the draft'),
      );
    } finally {
      m.unmount();
    }
  });

  it('keeps the rule, the status line and the hint while a turn runs, and the in-flight turn takes the prompt’s place', async () => {
    const m = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      m.store.apply(turnStarted);
      await m.until(() => m.text().includes('Working'));
      const rows = m.frame();
      const shown = rows.join('\n');
      const at = ruleAt(rows);
      expect(rows[at - 1], shown).toContain('Working');
      expect(m.text(), 'no prompt while a turn runs').not.toContain('reply to continue');
      expect(rows[at + 1], shown).toContain(' · ask mode · ');
      expect(rows[at + 2], shown).toBe(indent(80, `[Ctrl+C] ${LEAVES[host].twice}`));
      expect(rows.length, 'the frame keeps its height').toBe(23);
    } finally {
      m.unmount();
    }
  });

  it('names the host’s destination in the Interrupting line too, once the first Ctrl+C has stopped a running turn', async () => {
    const m = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      m.store.apply(turnStarted);
      await m.until(() => m.text().includes('Working'));
      m.key(CTRL_C);
      await m.until(() => m.text().includes('Interrupting'));
      expect(m.text()).toContain(`Interrupting · [Ctrl+C] ${LEAVES[host].again}`);
      expect(m.frame().at(-1)).toBe(indent(80, `[Ctrl+C] ${LEAVES[host].again}`));
    } finally {
      m.unmount();
    }
  });

  it('puts the newest warning, then the earlier ones, in the leading row: the block never grows', async () => {
    const m = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      const before = m.frame();
      m.store.note('first note');
      m.store.note('second note');
      await m.until(() => m.text().includes('second note'));
      const rows = m.frame();
      const at = ruleAt(rows);
      expect(rows[at - 2], rows.join('\n')).toMatch(/second note.*first note/u);
      expect(rows.length).toBe(before.length);
      expect(ruleAt(before), 'the prompt did not move').toBe(at);
    } finally {
      m.unmount();
    }
  });

  it('invites a first message in a new conversation and a reply in a conversation that has begun', async () => {
    const fresh = await mountIn(host, ALT_80, setupWith());
    try {
      expect(fresh.text()).toContain('type a message');
      expect(fresh.text()).not.toContain('reply to continue');
    } finally {
      fresh.unmount();
    }
    const begun = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      expect(begun.text()).toContain('reply to continue');
      expect(begun.text()).not.toContain('type a message');
    } finally {
      begun.unmount();
    }
  });

  it('shows no placeholder beside a draft, and the first key typed replaces it', async () => {
    const m = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      m.key('x');
      await m.until(() => !m.text().includes('reply to continue'));
      const rows = m.frame();
      // the cursor cell is a blank after the `x`
      expect(rows[ruleAt(rows) - 1]).toBe(indent(80, '> x '));
    } finally {
      m.unmount();
    }
  });

  it('keeps the status line but draws no prompt and no hint while the history search owns the bottom of the view', async () => {
    const m = await mountIn(host, ALT_80, setupWith({ prepare: (s) => s.appendUser('hi') }));
    try {
      m.key('\u0012'); // Ctrl+R
      await m.until(() => m.text().includes('search'));
      const text = m.text();
      expect(text).toContain(' · ask mode · ');
      expect(text, 'a hint naming keys the search does not take').not.toContain('[/] commands');
      expect(text).not.toContain('reply to continue');
    } finally {
      m.unmount();
    }
  });
});

describe('the hint of a state, as the builders write it', () => {
  it('writes the idle hint for each host, and the draft’s own with a draft', () => {
    expect(idleHint(false, true)).toBe('[/] commands · [Ctrl+C] end (twice)');
    expect(idleHint(false, true, 'standalone-chat')).toBe('[/] commands · [Ctrl+C] end (twice)');
    expect(idleHint(false, true, 'home-chat')).toBe('[/] commands · [Ctrl+C] back to Home (twice)');
    expect(idleHint(true, true, 'home-chat')).toBe('[Ctrl+C] back to Home (again)');
    expect(idleHint(true, false, 'standalone-chat')).toBe('[Ctrl+C] end the session (again)');
    for (const host of ['home-chat', 'standalone-chat'] as const)
      expect(idleHint(false, false, host)).toBe(
        'Enter send · [Ctrl+J] newline · [Ctrl+C] clear the draft',
      );
  });

  it('writes the running hint for each host: only the key that leaves, since there is no prompt to type in and no palette to open', () => {
    expect(runningHint(false)).toBe('[Ctrl+C] end (twice)');
    expect(runningHint(false, 'home-chat')).toBe('[Ctrl+C] back to Home (twice)');
    expect(runningHint(true, 'home-chat')).toBe('[Ctrl+C] back to Home (again)');
    expect(runningHint(true, 'standalone-chat')).toBe('[Ctrl+C] end the session (again)');
    expect(runningHint(false, 'standalone-chat')).not.toContain('commands');
  });
});

describe('the copy confirmation takes the leading row of the block', () => {
  it('is drawn above the prompt in place of the blank row, and the block stays five rows', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const state = store.getSnapshot().state;
    const frameOf = (copied: boolean): string[] => {
      const view = render(
        <ChatView
          state={state}
          columns={80}
          color={false}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          copied={copied}
        />,
      );
      const rows = (view.lastFrame() ?? '').split('\n');
      view.unmount();
      return rows;
    };
    const resting = frameOf(false);
    const copied = frameOf(true);
    expect(resting[0]?.trim(), 'the leading row at rest is blank').toBe('');
    expect(copied[0]).toBe(indent(80, '[Sent to terminal clipboard]'));
    expect(copied.length).toBe(resting.length);
    expect(copied.slice(1)).toEqual(resting.slice(1));
  });
});
