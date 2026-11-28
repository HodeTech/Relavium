import './force-color.js';
import type { SessionStreamHandleEvent } from '@relavium/core';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * The live region of a running turn is one budget (MVP-11 review of PR #103, B1). Its parts (the tool calls, the reasoning panel, the streamed answer,
 * the interrupt note) each had a bound of their own, and together they could be taller than the frame, so the rule, the status line and the hint of the
 * prompt block were pushed out of it: at 80×24 the person lost the mode, the cost and the way to stop the turn exactly when a turn was busiest.
 * Read from the DRAWN frame of both hosts in the alternate screen.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
] as const;

let seq = 1;
const event = (body: Record<string, unknown>): SessionStreamHandleEvent =>
  ({
    sessionId: 'budget-session',
    sequenceNumber: seq++,
    timestamp: '2026-11-28T09:00:00.000Z',
    ...body,
  }) as SessionStreamHandleEvent;
const toolCall = (toolId: string): SessionStreamHandleEvent =>
  event({ type: 'agent:tool_call', nodeId: 'relavium-chat', model: 'm', toolId, toolInput: {} });

/** A turn that is as tall as the live region gets: a full reasoning panel, many tool calls, and a long streamed answer. */
function busiestTurn(m: ChatMount): void {
  seq = 1;
  m.store.apply(event({ type: 'session:turn_started' }));
  const lines = Array.from({ length: 30 }, (_, i) => `thought ${String(i)} about the task`).join(
    '\n',
  );
  m.store.apply(event({ type: 'agent:reasoning', nodeId: 'relavium-chat', text: lines }));
  for (const id of ['read_file', 'grep', 'glob', 'write_file', 'run_command', 'search']) {
    m.store.apply(toolCall(id));
  }
  m.store.apply(
    event({
      type: 'agent:token',
      nodeId: 'relavium-chat',
      model: 'm',
      token: `${'answer words '.repeat(120)}end.`,
    }),
  );
  m.store.tick();
}

describe('the live region keeps the prompt block whole (alternate screen)', () => {
  for (const host of HOSTS) {
    for (const size of SIZES) {
      it(`${host} · ${String(size.cols)}×${String(size.rows)}: reasoning open, six tool calls and a long answer leave the rule, the status line and the hint on the frame`, async () => {
        const variant: Variant = { renderer: 'alt', color: false, size };
        const m =
          host === 'chat'
            ? await mountHostedChat(variant, { hosted: { session: { provider: 'anthropic' } } })
            : mountStandaloneChat(variant, { standalone: { provider: 'anthropic' } });
        try {
          await m.settle();
          busiestTurn(m);
          m.store.toggleReasoning();
          await m.until(() => m.text().includes('Reasoning'));
          await m.settle();
          const frame = m.frame();
          const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
          expect(frame.length, shown).toBeLessThanOrEqual(size.rows);
          // the prompt block is whole, bottom up: the hint on the last row, the status line above it, the thin rule above that
          const rows = frame.filter((row) => row.trim() !== '');
          expect(rows.at(-1), shown).toMatch(/\[Ctrl\+C\] (end|back to Home)/u);
          expect(rows.at(-2), shown).toMatch(/ask mode/u);
          expect(rows.at(-3), shown).toMatch(/^\s*[─-]{10,}\s*$/u);
          // the way to stop the turn (the busy line's) and the tail of the answer are on the frame: the newest rows are kept
          expect(
            frame.some((row) => row.includes('Esc stops the turn')),
            shown,
          ).toBe(true);
          expect(
            frame.some((row) => row.includes('end.')),
            shown,
          ).toBe(true);
        } finally {
          m.unmount();
        }
      });
    }
  }
});
