/**
 * A line typed at the landing and the same line pasted are answered alike
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3, `home.md` "Typed
 * slash words"): a `/` at an empty prompt opens the palette, so a line typed key by key reaches its answer through the palette's `Enter` on a
 * query that matches no command, and a pasted line reaches it through the prompt's submit. Both must say the same thing. They did not for
 * a Home command given arguments: the paste said `/run accepts no arguments. …` and the typed line said `Unknown command: /run.`, which is
 * false, because `/run` is a command.
 *
 * Through the real Home controller; the ports and the timers are scripted.
 */
import { describe, expect, it } from 'vitest';

import { createHomeController, type HomeController } from './home-controller.js';

function mount(): HomeController {
  return createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: {
      read: () => ({
        attention: { gates: [], failedRuns: [] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRunIds: [],
        isEmpty: true,
      }),
    },
    schedule: () => () => {},
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
}

const ENTER = { return: true } as const;

/** What the landing says to `line` pasted (it enters the prompt as one event, so the `/` does not open the palette) and submitted. */
function pasted(line: string): string | undefined {
  const home = mount();
  home.handlePaste(line);
  home.handleKey('', ENTER);
  return home.getSnapshot().notice;
}

/** What it says to the same line typed key by key: the first `/` opens the palette, whose `Enter` answers a query that matches nothing. */
function typed(line: string): string | undefined {
  const home = mount();
  for (const char of line) home.handleKey(char, {});
  home.handleKey('', ENTER);
  return home.getSnapshot().notice;
}

describe('a Home command given arguments is answered alike typed and pasted', () => {
  it.each([
    ['/run extra', '/run accepts no arguments. Use its picker to choose a workflow.'],
    ['/resume x', '/resume accepts no arguments. Use its picker to select a session.'],
    ['/permissions x', '/permissions accepts no arguments.'],
    ['/workflows x', '/workflows accepts no arguments.'],
    ['/agents x', '/agents accepts no arguments.'],
    ['/import x', '/import accepts no arguments. It asks for the path.'],
    ['/pricing x', '/pricing accepts no arguments.'],
    ['/init x', '/init accepts no arguments.'],
    ['/providers x', '/providers accepts no arguments.'],
    ['/mode plan', 'No conversation is active. Use /mode to set the startup default.'],
  ])('%s', (line, answer) => {
    expect(pasted(line), 'the paste').toBe(answer);
    expect(typed(line), 'the same line typed').toBe(answer);
  });

  it('never says a command is unknown when it is one', () => {
    for (const line of ['/run extra', '/agents x', '/init x', '/providers x'])
      expect(typed(line)).not.toContain('Unknown command');
  });

  it.each(['/help x', '/doctor x', '/foo', '/inti', '/Zzzz', '/exit now'])(
    'the lines the palette already answered as a paste does are still answered alike: %s',
    (line) => {
      expect(typed(line)).toBe(pasted(line));
    },
  );
});
