/**
 * The launch confirmation at its largest, drawn for real at 80×24 (P1-7, M-3), now the `/run` popup's chord step (ADR-0148 §1, §3; MVP-11 unit 6).
 *
 * The confirmation carries a passage about what the run can do under its question. Both are bounded (280 and 200 characters), and this proves the
 * bound holds in the popup at the floor: the step is painted whole in the Home's popup frame and acknowledged as visible, it never degrades to the
 * popup's "does not fit" notice (a chord step that is not wholly on its page is never answered), its legend row names every answer
 * (`[Ctrl+Y] Start it · [Ctrl+N] Cancel · Esc back · [Ctrl+C] denies`), and the answer keys still reach it. The worst case is built from a real
 * workflow: the widest scope sentence, four long MCP server names and the most inputs that fill the question.
 */
import { parseWorkflow } from '@relavium/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import { createRunLaunch, LAUNCH_CANCELLED, type LaunchCatalog } from './run-launch.js';

/** A real wait past the popup's opening settle (the Home's channel runs on the real clock): an answer before it is no answer. */
const PAST_THE_OPENING_MS = POPUP_SELECT_SETTLE_MS + 100;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mounts: HomeMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const INPUTS = 10;
const SERVER = 'a-server-with-a-long-name-for-the-card';
const WORST_CASE = `schema_version: '1.0'
workflow:
  id: worst-case-confirmation-with-a-long-id
  name: A workflow with a deliberately long name for its card
  inputs:
${Array.from({ length: INPUTS }, (_, index) => `    - { name: field-${String(index + 1)}, type: string }`).join('\n')}
  tools:
    allowedCommands: ['a-long-allowed-command-name-one --with --flags', 'a-long-allowed-command-name-two --with --flags', 'three']
    allowedCommandGlobs: ['make *']
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [run_command, git_status, git_commit, write_file]
      mcp_servers:
        - { ref: ${SERVER}-one }
        - { ref: ${SERVER}-two }
        - { ref: ${SERVER}-three }
        - { ref: ${SERVER}-four }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: worker }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`;

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed: what a key that counts waits for. */
function shownNow(m: HomeMount): boolean {
  const channel = m.channel;
  if (channel === undefined) return false;
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

describe('the longest confirmation at 80x24, in the /run popup', () => {
  it.each(['alt', 'inline'] as const)(
    '%s: is painted whole and visible in the popup frame, names every answer, and the answer keys reach it',
    async (renderer) => {
      const m = mountHome(
        { renderer, color: false, size: { cols: 80, rows: 24 } },
        { nativePrompt: true },
      );
      mounts.push(m);
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');

      const definition = parseWorkflow(WORST_CASE, { source: 'worst-case' });
      const start = vi.fn();
      const catalog: LaunchCatalog = {
        list: () => [
          {
            path: 'worst.yaml',
            slug: definition.workflow.id,
            valid: true,
            tags: [],
            name: definition.workflow.name,
          },
        ],
        load: () => ({
          definition,
          sourceDigest: 'd'.repeat(64),
          fsScope: { tier: 'full', fromRepository: true },
        }),
      };
      const launch = createRunLaunch({ flow: channel.flow, host: { start }, catalog });
      const opened = launch.open(definition.workflow.id);
      for (let index = 1; index <= INPUTS; index += 1) {
        // A key is delivered only to a prompt that was painted and measured: wait for that, as a person's eyes do.
        await m.until(
          () =>
            channel.ui
              .getSnapshot()
              .message.includes(`Input ${String(index)} of ${String(INPUTS)}`) && shownNow(m),
        );
        expect(channel.ui.getSnapshot().message).toContain(
          `Input ${String(index)} of ${String(INPUTS)}`,
        );
        // The first field is the popup's first frame: its `Enter` waits out the opening settle once (ADR-0148 §3), as a person's would.
        if (index === 1) await pause(PAST_THE_OPENING_MS);
        m.key(`value-${String(index)}-padding-padding\r`);
      }
      await m.until(() => channel.ui.getSnapshot().kind === 'chord' && shownNow(m));
      const card = channel.ui.getSnapshot();
      expect(card.kind).toBe('chord');
      expect(card.popup).toMatchObject({ title: '/run', stepIndex: 2 });
      // The host's passage and the question, each bounded: 280 and 200 characters.
      const passage = card.details.join(' ');
      expect(passage.length, 'the host`s passage, near its bound').toBeGreaterThan(240);
      expect(passage.length).toBeLessThanOrEqual(280);
      expect(passage).toContain('"a-long-allowed-comman…"');
      expect(passage).toContain('start processes (git_commit, git_status)');
      expect(card.message.length).toBeLessThanOrEqual(200);
      expect(card.message).toContain(' more?');
      expect(card.message, 'nothing of the host in the question').not.toContain('File scope');

      expect(shownNow(m), 'the step was measured and flushed at 80x24').toBe(true);
      const text = m.text();
      expect(text).toContain('/run');
      expect(text).toContain('step 3 of 3');
      expect(text).toContain('[Ctrl+Y] Start it · [Ctrl+N] Cancel · Esc back · [Ctrl+C] denies');
      expect(text).toContain('does not limit');
      expect(text).not.toMatch(/too long for a popup|too small for this popup/u);

      // `Ctrl+N` is never delayed: it reaches the step and leaves it, and nothing starts.
      m.key('\u000e');
      expect(await opened).toBe(LAUNCH_CANCELLED);
      expect(start).not.toHaveBeenCalled();
    },
  );
});
