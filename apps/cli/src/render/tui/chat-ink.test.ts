import { describe, expect, it } from 'vitest';

import { commandsOf } from '../../commands/repl-commands.js';
import { finalizeInkExit, emitIntro, idleHint } from './chat-ink.js';
import { reduceChatKey } from './chat-input.js';
import { DISARMED, pressInterrupt } from './interrupt-keymap.js';
import { shouldOpenPalette } from './palette-reducer.js';

/** The keys a legend row lists: the first word of each ` · ` item, as written (brackets and all). */
const listedKeys = (row: string): string[] =>
  row.split(' \u00b7 ').map((item) => item.split(' ')[0] ?? '');

/**
 * `finalizeInkExit` unit tests (2.6.F Step 4a, refined at Step 4b-3, ADR-0068 §c) — the teardown-then-outcome
 * sequencing. Actual-driver setup failure and activation are covered offline in `chat-effect-activation.test.ts`;
 * mounted component publication is covered in `chat-app.test.tsx`. These smaller tests isolate exit sequencing.
 * At Step 4b-3 the end-of-session SUMMARY no longer writes here — the alt-buffer exit moved UP to the
 * hoisted `runReplLoop`, so the summary rides on the outcome (`summaryText`) and the loop prints it after the single
 * alt-exit. These pin that teardown runs before the outcome resolves, and is SKIPPED-of-outcome on a reject.
 */
describe('finalizeInkExit — teardown-before-outcome order (ADR-0068 §c)', () => {
  it('on a cooperative resolve: tears down (unmount) BEFORE resolving the outcome (which carries the summary)', async () => {
    const calls: string[] = [];
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => calls.push('teardown'),
      outcome: () => {
        calls.push('outcome');
        return { kind: 'exit', summaryText: 'session over' };
      },
    });
    expect(calls).toEqual(['teardown', 'outcome']); // teardown (unmount) first, then the outcome is read
    // The summary rides on the outcome — the hoisted runReplLoop prints it AFTER the single alt-exit (primary buffer).
    expect(outcome).toEqual({ kind: 'exit', summaryText: 'session over' });
  });

  it('on a reject (an unexpected turn-core throw): tears down, SKIPS the outcome, and propagates unchanged', async () => {
    const calls: string[] = [];
    const boom = new Error('turn-core exploded');
    await expect(
      finalizeInkExit(Promise.reject(boom), {
        teardown: () => calls.push('teardown'),
        outcome: () => {
          calls.push('outcome');
          return { kind: 'exit' };
        },
      }),
    ).rejects.toBe(boom); // the rejection propagates → the command maps it to exit 1 (pre-2.6.F behavior preserved)
    expect(calls).toEqual(['teardown']); // teardown ran; the outcome (and its summary) was NOT read on the error path
  });

  it('forwards the resolved outcome kind (a /clear swap ⇒ the caller re-drives, no summary)', async () => {
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => {},
      outcome: () => ({ kind: 'clear' }), // a /clear swap carries no summaryText
    });
    expect(outcome).toEqual({ kind: 'clear' });
  });
});

/**
 * WHERE the intro goes (2.6.F Step 6g, whole-phase Opus review). The alt buffer has no scrollback and ink's first
 * frame is `height: rows`, so a pre-mount `writeOut` is painted over and gone. `/clear`'s notice carries
 * `relavium chat-resume <id>` — the ONLY pointer back to the conversation it just ended — and the default renderer
 * was throwing it away.
 */
describe('emitIntro — the renderer decides where the intro survives', () => {
  const ports = (): {
    notices: string[];
    outs: string[];
    notice: (t: string) => void;
    writeOut: (t: string) => void;
  } => {
    const notices: string[] = [];
    const outs: string[] = [];
    return { notices, outs, notice: (t) => notices.push(t), writeOut: (t) => outs.push(t) };
  };

  it('FULL-SCREEN: into the transcript, where the viewport keeps it', () => {
    const p = ports();
    emitIntro(
      'Started a fresh conversation. Resume the old one with `relavium chat-resume id-0`.',
      true,
      p,
    );
    expect(p.notices).toEqual([
      'Started a fresh conversation. Resume the old one with `relavium chat-resume id-0`.',
    ]);
    expect(p.outs).toEqual([]); // never a pre-mount write: the alt buffer erases it
  });

  it('INLINE: printed above the live region, with its newline — byte-identical to before', () => {
    const p = ports();
    emitIntro('Resumed session id-0 (3 turns).', false, p);
    expect(p.outs).toEqual(['Resumed session id-0 (3 turns).\n']);
    expect(p.notices).toEqual([]);
  });

  it('a FRESH session has no intro, and neither sink is touched', () => {
    for (const alt of [true, false]) {
      const p = ports();
      emitIntro(undefined, alt, p);
      expect(p.notices).toEqual([]);
      expect(p.outs).toEqual([]);
    }
  });
});

/** The idle prompt's hint bar says what the keys do now: end the session, open the palette, send, or clear (2.5.C S6). */
describe('idleHint — what the idle prompt tells the person to press', () => {
  it('asks for the second Ctrl+C while the first is armed, whatever the draft holds', () => {
    expect(idleHint(true, true)).toBe('[Ctrl+C] end the session (again)');
    expect(idleHint(true, false)).toBe('[Ctrl+C] end the session (again)');
  });

  it('offers the palette and the two ways out at an empty prompt, and the submit hint once composing', () => {
    expect(idleHint(false, true)).toBe(
      '[/] for commands \u00b7 /exit end \u00b7 [Ctrl+C] end (twice)',
    );
    expect(idleHint(false, false)).toBe(
      'Enter send \u00b7 [Ctrl+J] newline \u00b7 [Ctrl+C] clear the draft',
    );
  });

  it('lists only keys the prompt answers, and each does what its word says (ADR-0145 §3: a test presses every key a legend lists)', () => {
    const now = 1000;
    // At an empty prompt: `/` opens the palette, `/exit` is a typed command of the chat's registry (named, not a key), `Ctrl+C` twice ends the session.
    expect(listedKeys(idleHint(false, true))).toEqual(['[/]', '/exit', '[Ctrl+C]']);
    expect(shouldOpenPalette('/', {}, false, 0)).toBe(true);
    expect(commandsOf('standalone-chat').map((command) => command.name)).toContain('exit');
    const first = pressInterrupt(DISARMED, { kind: 'prompt', hasText: false }, now);
    expect(first.action).toBe('arm-hint');
    expect(pressInterrupt(first.state, { kind: 'prompt', hasText: false }, now + 1).action).toBe(
      'end-session',
    );
    // Armed, the one key the bar lists is that second `Ctrl+C`.
    expect(listedKeys(idleHint(true, true))).toEqual(['[Ctrl+C]']);
    // Composing: `Enter` sends the line, `Ctrl+J` (a bare line feed) is a newline, and `Ctrl+C` clears the draft and arms nothing.
    expect(listedKeys(idleHint(false, false))).toEqual(['Enter', '[Ctrl+J]', '[Ctrl+C]']);
    expect(reduceChatKey('', { return: true }, 'hello', false)).toEqual({
      kind: 'submit',
      line: 'hello',
    });
    expect(reduceChatKey('\n', {}, 'hello', false)).toEqual({ kind: 'newline' });
    const cleared = pressInterrupt(DISARMED, { kind: 'prompt', hasText: true }, now);
    expect(cleared.action).toBe('clear-text');
    expect(cleared.state, 'a draft cleared arms nothing').toEqual(DISARMED);
  });
});
