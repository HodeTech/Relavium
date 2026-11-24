/**
 * The launch confirmation at its largest, drawn for real at 80×24 (P1-7, M-3).
 *
 * The confirmation grew a sentence about what the run can do, above its question. Both are bounded (200 characters each), and this proves
 * the bound holds on a terminal: the card is painted whole and acknowledged as visible, it never degrades to `Prompt does not fit`, and
 * the answer keys still reach it. The worst case is built from a real workflow: the widest scope sentence, three long MCP server names
 * and the most inputs that fill the question.
 */
import { parseWorkflow } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { NativePromptHost } from '../render/tui/native-prompt-host.js';
import { createRunLaunch, LAUNCH_CANCELLED, type LaunchCatalog } from './run-launch.js';

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const close of mounts.splice(0)) close();
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
    allowedCommands: ['npm test', 'git status']
    allowedCommandGlobs: ['make *']
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [run_command, write_file]
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

describe('the longest confirmation at 80x24', () => {
  it('is painted whole and visible, and the answer keys reach it', async () => {
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    output.columns = 80;
    output.rows = 24;
    const channel = createNativePromptChannel();
    const instance = render(
      createElement(NativePromptHost, {
        ui: channel.ui,
        color: false,
        onRendererReady: () => undefined,
      }),
      {
        stdin: input,
        stdout: output,
        stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: false,
      },
    );
    mounts.push(() => {
      channel.ui.dispose();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    });

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
    const launch = createRunLaunch({
      flow: channel.flow,
      host: { start },
      catalog,
    });
    const opened = launch.open(definition.workflow.id);
    for (let index = 1; index <= INPUTS; index += 1) {
      await vi.waitFor(() => {
        const field = channel.ui.getSnapshot();
        expect(field.message).toContain(`Input ${String(index)} of ${String(INPUTS)}`);
        // A key is delivered only to a card that was painted and measured: wait for that, as a person's eyes do.
        expect(() => channel.ui.assertVisible(field)).not.toThrow();
      });
      input.push(`value-${String(index)}-padding-padding\r`);
    }
    await vi.waitFor(() => {
      expect(channel.ui.getSnapshot().message).toContain(
        'File scope: full, set by this repository.',
      );
    });
    const card = channel.ui.getSnapshot();
    expect(card.kind).toBe('select');
    expect(card.message.length, 'two bounded sentences').toBeLessThanOrEqual(401);
    expect(card.message).toContain(' more?');

    await vi.waitFor(() => {
      expect(
        () => channel.ui.assertVisible(card),
        'the card was measured and flushed at 80x24',
      ).not.toThrow();
    });
    expect(output.frames.join('')).not.toContain('Prompt does not fit');
    expect(output.frames.join('')).toContain('Run commands'.toLowerCase());

    // `Enter` on the default (No) leaves the card: nothing starts.
    input.push('\r');
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(start).not.toHaveBeenCalled();
  });
});
