import './force-color.js';

import type { AskUserRequest, ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { dockedCardOpen } from './chat-ink.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { NO_OVERLAYS } from './overlay-flags.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * OB7-L2 (the observation of unit 7's chat half): while an approval, command, question or checkpoint card was open, the hint row above it still said
 * `[Ctrl+C] end (twice)` while the card's own legend said `Esc / [Ctrl+C] stops the turn`: two legends on one screen, disagreeing about what the keys
 * do. Unit 7 blanked the hint row; since unit 8 the card is a SHEET that takes the whole prompt block's place (ADR-0147 §1): while one is docked
 * neither the status line nor the hint is drawn (its key lines are the legend, its rule the label), and both come back when it is answered. Tested in
 * both hosts and both renderers over each kind of card.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
const RENDERERS = ['alt', 'inline'] as const;

const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: false,
  size: { cols: 100, rows: 40 },
});

const FILE_WRITE: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const EDIT_PREVIEW: ToolPreview = editedFilePreview(12, { 4: 'const answer = 42;' });
const COMMAND_REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const COMMAND_PREVIEW: ToolPreview = {
  kind: 'operation',
  target: 'npm test',
  fields: [
    { name: '', value: 'npm' },
    { name: '', value: 'test' },
  ],
};
const COMMAND_FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};
const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file should I change?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

interface CardKind {
  readonly name: string;
  readonly landmark: string;
  readonly open: (m: ChatMount) => void;
}
const CARDS: readonly CardKind[] = [
  {
    name: 'a file-edit approval',
    landmark: 'Esc stops the turn',
    open: (m) => {
      m.store
        .requestApproval(FILE_WRITE, true, undefined, { callId: 'call-1', preview: EDIT_PREVIEW })
        .catch(() => undefined);
    },
  },
  {
    name: 'a command approval',
    landmark: 'Standing:',
    open: (m) => {
      m.store
        .requestApproval(
          COMMAND_REQUEST,
          COMMAND_FACTS.offers.session,
          undefined,
          { callId: 'call-2', preview: COMMAND_PREVIEW },
          COMMAND_FACTS,
        )
        .catch(() => undefined);
    },
  },
  {
    name: 'the agent’s question',
    landmark: 'Which file should I change?',
    open: (m) => {
      m.store.requestQuestion(QUESTION).catch(() => undefined);
    },
  },
  {
    name: 'the continue checkpoint',
    landmark: 'Continue for 32 more?',
    open: (m) => {
      m.store.requestCheckpoint({ rounds: 32, interval: 32 }).catch(() => undefined);
    },
  },
];

/** The words of the hints the chat itself draws on its hint row. */
const CHAT_HINT = /\(twice\)|\(again\)|\[\/\] commands|clear the draft|Enter send/u;

async function mountIn(
  host: (typeof HOSTS)[number],
  renderer: 'alt' | 'inline',
): Promise<ChatMount> {
  const setup = {
    prepare: (store: ChatMount['store']) => store.appendUser('hello'),
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
  };
  const mount =
    host === 'chat'
      ? await mountHostedChat(variant(renderer), setup)
      : mountStandaloneChat(variant(renderer), setup);
  await mount.settle();
  return mount;
}

/** The row under the status line: the hint row of the prompt block. */
function hintRowOf(mount: ChatMount): string | undefined {
  const rows = mount.frame();
  const status = rows.findLastIndex((row) => /ask mode · \d+ turn/u.test(row));
  return status < 0 ? undefined : rows[status + 1];
}

describe.each(HOSTS)('the hint row while a card is docked, in the %s host', (host) => {
  describe.each(RENDERERS)('%s renderer', (renderer) => {
    it.each(CARDS)(
      'is not drawn under $name, nor is the status line: the sheet takes the prompt block’s place (ADR-0147 §1)',
      async (card) => {
        const m = await mountIn(host, renderer);
        try {
          expect(hintRowOf(m), 'before the card, the hint row says its keys').toMatch(CHAT_HINT);
          card.open(m);
          const shown = await m.until(() => m.text().includes(card.landmark));
          expect(shown, m.text()).toBe(true);
          await m.settle();
          expect(hintRowOf(m), `no status line with the sheet:\n${m.text()}`).toBeUndefined();
          expect(m.text(), 'no chat hint is on the screen with the card').not.toMatch(CHAT_HINT);
          expect(m.text(), 'the sheet’s heavy rule is drawn').toMatch(/^== .+ ==$/mu);
        } finally {
          m.unmount();
        }
      },
    );

    it('returns when the card is answered', async () => {
      const m = await mountIn(host, renderer);
      try {
        CARDS[0]?.open(m);
        await m.until(() => m.text().includes('Esc stops the turn'));
        await m.settle();
        // answered through the store, as the card's own host does once it has custody of the keys
        m.store.answerApproval({ outcome: 'reject' });
        const back = await m.until(() => !m.text().includes('Approval needed'));
        expect(back, m.text()).toBe(true);
        const returned = await m.until(() => CHAT_HINT.test(hintRowOf(m) ?? ''));
        expect(returned, m.text()).toBe(true);
      } finally {
        m.unmount();
      }
    });
  });
});

describe('dockedCardOpen', () => {
  it('is true for each docked card and for nothing else', () => {
    expect(dockedCardOpen(NO_OVERLAYS)).toBe(false);
    expect(dockedCardOpen({ ...NO_OVERLAYS, approval: true })).toBe(true);
    expect(dockedCardOpen({ ...NO_OVERLAYS, question: true })).toBe(true);
    expect(dockedCardOpen({ ...NO_OVERLAYS, checkpoint: true })).toBe(true);
    for (const flag of ['palette', 'search', 'mention', 'popup', 'nativePrompt', 'review'] as const)
      expect(dockedCardOpen({ ...NO_OVERLAYS, [flag]: true }), flag).toBe(false);
  });
});
