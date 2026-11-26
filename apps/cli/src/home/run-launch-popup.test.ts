/**
 * `/run` as a popup (ADR-0148 §1, §3, §6; MVP-11 unit 6, 6.4), on the real native prompt channel with its real guards and an injected clock (the
 * host's acknowledgement played by hand): the frame of each step and its rail, `Esc` and `Ctrl+C` at every step, the confirmation answered by
 * `Ctrl+Y` alone past the chord card's guards (a key held across it never starts a run, one patient press after it is let go does), a masked
 * input framed (never in a snapshot, emptied by a resize), the start drawn without the frame (the MCP consent card it may raise is a card), and
 * every word a project wrote put through the full scrub before it reaches the channel.
 *
 * The rest of the launch (the machine, the catalog, the host, the bindings) is `run-launch.test.ts`'s, over a real project and run host.
 */
import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_RESIZED,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import type { HostedLaunch, HostedStartRequest } from './run-host.js';
import {
  createRunLaunch,
  LAUNCH_CANCELLED,
  RUN_CONFIRM_ALLOW,
  RUN_CONFIRM_DENY,
  RUN_FRAME,
  startedNotice,
  type LaunchCatalog,
  type LaunchState,
} from './run-launch.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const ESC: Key = { ...none, escape: true };
const CTRL: Key = { ...none, ctrl: true };
const REPEAT = (key: Key): Key => ({ ...key, eventType: 'repeat' });

/** A number, a secret and a boolean: the three kinds of field the form asks. */
const FORM = `schema_version: '1.0'
workflow:
  id: release-notes
  name: Release notes
  inputs:
    - { name: version, type: string, required: true }
    - { name: token, type: secret, required: true }
    - { name: draft, type: boolean }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** One number: the confirmation follows its one field. */
const ONE = `schema_version: '1.0'
workflow:
  id: one-field
  inputs:
    - { name: n, type: number, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** A catalog over workflow texts held in memory: no project, no file. */
function catalogOf(workflows: Readonly<Record<string, string>>): LaunchCatalog {
  return {
    list: () =>
      Object.entries(workflows).map(([path, yaml]) => {
        const definition = parseWorkflow(yaml, { source: path });
        return {
          path,
          slug: definition.workflow.id,
          name: definition.workflow.name,
          tags: [],
          valid: true,
        };
      }),
    load: (path) => ({
      definition: parseWorkflow(workflows[path] ?? '', { source: path }),
      sourceDigest: 'd'.repeat(64),
      fsScope: { tier: 'sandboxed', fromRepository: false },
    }),
  };
}

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'start',
  runId: '0123456789abcdef-run',
  ended: new Promise(() => {}),
};

/** The real channel with its real guards on a clock the test moves; the host's acknowledgement is `show`. */
function rig(
  workflows: Readonly<Record<string, string>>,
  start: (request: HostedStartRequest) => Promise<HostedLaunch> = () => Promise.resolve(STARTED),
) {
  let clock = 10_000;
  const history = createChordHistory();
  const channel = createNativePromptChannel({ now: () => clock, history });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  const snapshots: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => snapshots.push(channel.ui.getSnapshot()));
  const states: LaunchState[] = [];
  const host = { start: vi.fn(start) };
  const launch = createRunLaunch({
    flow: channel.flow,
    host,
    catalog: catalogOf(workflows),
    observe: (state) => states.push(state),
  });
  return {
    channel,
    history,
    host,
    launch,
    snapshots,
    states,
    now: () => clock,
    at: (time: number): void => {
      clock = time;
    },
    advance: (ms: number): void => {
      clock += ms;
    },
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    /** The frame on the channel now was measured and flushed (the host's acknowledgement). */
    show: (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    },
    key: (key: Key, input = ''): boolean => channel.ui.input(input, key),
    type: (text: string): void => {
      for (const character of text) channel.ui.input(character, none);
    },
  };
}
type Rig = ReturnType<typeof rig>;

/** Let the launch's effects run (each answer reaches the machine a few microtasks later). */
async function until(r: Rig, holds: (snapshot: NativePromptSnapshot) => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !holds(r.snapshot()); turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(holds(r.snapshot()), `the prompt is ${r.snapshot().kind}: ${r.snapshot().message}`).toBe(
    true,
  );
}

/**
 * Open the launch, and pick the first workflow once the popup's opening settle has passed on its first frame. The launch's own promise comes
 * back wrapped (an `async` function that returned it would wait for it).
 */
async function toFirstField(r: Rig): Promise<{ readonly opened: Promise<string> }> {
  const opened = r.launch.open();
  await until(r, (s) => s.kind === 'select' && s.message === 'Run which workflow?');
  r.show();
  r.advance(POPUP_SELECT_SETTLE_MS + 1);
  r.key(ENTER);
  return { opened };
}

/** Answer the one field of {@link ONE} and leave the confirmation up, on screen. Returns the time its field's `Enter` answered. */
async function toConfirmation(r: Rig): Promise<number> {
  await until(r, (s) => s.kind === 'text');
  r.show();
  r.type('3');
  const answeredAt = r.now();
  r.key(ENTER);
  await until(r, (s) => s.kind === 'chord');
  return answeredAt;
}

describe('the frame of each step', () => {
  it('Workflow, Inputs, Confirm: the picker, every field and the chord confirmation, each on its own step of the one rail', async () => {
    // What the channel shows while the host has the start (the moment an MCP consent card it raises would be asked).
    let during: NativePromptSnapshot | undefined;
    const r = rig({ 'release.yaml': FORM }, () => {
      during = r.snapshot();
      return Promise.resolve(STARTED);
    });
    const opened = r.launch.open();
    await until(r, (s) => s.kind === 'select');
    expect(r.snapshot().popup).toEqual({
      title: '/run',
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: ['Workflow', 'Inputs', 'Confirm'],
      exitLabel: 'close',
      depth: 1,
    });
    expect(r.snapshot().escape, 'the picker has nothing to step back to').toBe('cancel');
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS + 1);
    r.key(ENTER);
    // The three fields, all on the Inputs step, each stepping back on `Esc`.
    await until(r, (s) => s.kind === 'text');
    expect(r.snapshot()).toMatchObject({ escape: 'back', popup: { stepIndex: 1 } });
    r.type('v1');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'password');
    expect(r.snapshot()).toMatchObject({ escape: 'back', popup: { stepIndex: 1 } });
    r.type('tok-1');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'select' && s.message.includes('draft'));
    expect(r.snapshot()).toMatchObject({ escape: 'back', popup: { stepIndex: 1 } });
    expect(r.snapshot().options.map((option) => option.label)).toEqual([
      'true',
      'false',
      '(use the default)',
    ]);
    r.key(ENTER);
    // The confirmation: the chord card on the Confirm step, its answers in the product's words.
    await until(r, (s) => s.kind === 'chord');
    const card = r.snapshot();
    expect(card.popup).toMatchObject({ stepIndex: 2 });
    expect(card.escape).toBe('back');
    expect(card.message).toBe('Run Release notes with version=v1, token=••••, draft=true?');
    expect(card.options).toEqual([
      { value: 'allow', label: RUN_CONFIRM_ALLOW },
      { value: 'deny', label: RUN_CONFIRM_DENY },
    ]);
    // The start is no step of the popup: the frame is taken away while the host has it.
    r.show();
    r.advance(APPROVAL_LOCKOUT_MS + 1);
    r.key(CTRL, 'y');
    expect(await opened).toBe(
      startedNotice('Release notes', STARTED.kind === 'started' ? STARTED.runId : ''),
    );
    expect(during, 'the host was asked').toBeDefined();
    expect(during).toMatchObject({ kind: 'busy', message: 'Starting the run…' });
    expect(
      during?.popup,
      'the popup frame is taken away while the host has the start',
    ).toBeUndefined();
    const framedWait = r.snapshots.findIndex(
      (s) => s.kind === 'busy' && s.message === 'Starting the run…' && s.popup !== undefined,
    );
    const asked = r.snapshots.findIndex(
      (s) => s.kind === 'busy' && s.message === 'Starting the run…',
    );
    // The wait is never drawn in the frame before the host has it (it is published inside `unframed`).
    expect(framedWait === -1 || framedWait > asked).toBe(true);
    expect(RUN_FRAME.stepNames).toEqual(['Workflow', 'Inputs', 'Confirm']);
  });

  it('a value too long for the question is cut once, with the ellipsis the question drew (the question is not scrubbed a second time)', async () => {
    const r = rig({ 'release.yaml': FORM });
    const { opened } = await toFirstField(r);
    await until(r, (s) => s.kind === 'text');
    r.type('v'.repeat(40));
    r.key(ENTER);
    await until(r, (s) => s.kind === 'password');
    r.type('tok');
    r.key(ENTER);
    await until(r, (s) => s.message.includes('draft'));
    r.key(ENTER);
    await until(r, (s) => s.kind === 'chord');
    expect(r.snapshot().message).toContain(`version=${'v'.repeat(23)}…,`);
    expect(r.snapshot().message).not.toContain('...');
    r.key(CTRL, 'c');
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });

  it('a started run says so in one notification of at most 54 columns, its long name giving way to the run alone', () => {
    expect(startedNotice('Release notes', 'abcdef0123456789')).toBe(
      'Started Release notes · run abcdef01',
    );
    const long = startedNotice('A'.repeat(60), 'abcdef0123456789');
    expect(long).toBe('Started run abcdef01');
    for (const notice of [long, startedNotice('x', 'y')])
      expect(notice.length).toBeLessThanOrEqual(54);
  });
});

describe('Esc and Ctrl+C at every step', () => {
  it('Esc: the picker closes; a field steps back to the field before it (the first to the picker, on its step); the confirmation to the last field', async () => {
    const r = rig({ 'release.yaml': FORM });
    const { opened } = await toFirstField(r);
    await until(r, (s) => s.kind === 'text');
    r.type('v1');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'password');
    r.key(ESC); // the secret field: back to the first field
    await until(r, (s) => s.kind === 'text');
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.key(ESC); // the first field: back to the picker, on the Workflow step
    await until(r, (s) => s.kind === 'select' && s.message === 'Run which workflow?');
    expect(r.snapshot().popup?.stepIndex, 'the rail rewound').toBe(0);
    r.key(ENTER);
    await until(r, (s) => s.kind === 'text');
    r.type('v2');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'password');
    r.type('tok');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'select' && s.message.includes('draft'));
    r.key(ENTER);
    await until(r, (s) => s.kind === 'chord');
    r.key(ESC); // the confirmation: back to the last field
    await until(r, (s) => s.kind === 'select' && s.message.includes('draft'));
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.key(ESC);
    await until(r, (s) => s.kind === 'password');
    expect(r.snapshot().display, 'the secret is asked again from nothing').toBe('');
    r.key(ESC);
    await until(r, (s) => s.kind === 'text');
    r.key(ESC);
    await until(r, (s) => s.kind === 'select' && s.message === 'Run which workflow?');
    r.key(ESC); // the picker: the popup closes
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.host.start).not.toHaveBeenCalled();
    expect(r.snapshot().active).toBe(false);
  });

  it.each(['picker', 'field', 'secret', 'boolean', 'confirmation', 'start'] as const)(
    'Ctrl+C at the %s leaves the whole flow and starts nothing',
    async (step) => {
      let release: (launch: HostedLaunch) => void = () => undefined;
      const held = new Promise<HostedLaunch>((resolve) => {
        release = resolve;
      });
      const r = rig({ 'release.yaml': FORM }, () => held);
      const opened = r.launch.open();
      await until(r, (s) => s.kind === 'select');
      r.show();
      r.advance(POPUP_SELECT_SETTLE_MS + 1);
      const at: Record<typeof step, () => Promise<void>> = {
        picker: () => Promise.resolve(),
        field: async () => {
          r.key(ENTER);
          await until(r, (s) => s.kind === 'text');
        },
        secret: async () => {
          await at.field();
          r.type('v');
          r.key(ENTER);
          await until(r, (s) => s.kind === 'password');
          r.type('tok-secret');
        },
        boolean: async () => {
          await at.secret();
          r.key(ENTER);
          await until(r, (s) => s.message.includes('draft'));
        },
        confirmation: async () => {
          await at.boolean();
          r.key(ENTER);
          await until(r, (s) => s.kind === 'chord');
        },
        start: async () => {
          await at.confirmation();
          r.show();
          r.advance(APPROVAL_LOCKOUT_MS + 1);
          r.key(CTRL, 'y');
          await until(r, (s) => s.kind === 'busy' && s.message === 'Starting the run…');
        },
      };
      await at[step]();
      r.key(CTRL, 'c');
      expect(await opened).toBe(LAUNCH_CANCELLED);
      release({ kind: 'refused', reason: 'stopped', message: 'stopped' });
      expect(r.host.start).toHaveBeenCalledTimes(step === 'start' ? 1 : 0);
      expect(r.snapshot().active).toBe(false);
      expect(JSON.stringify(r.snapshots)).not.toContain('tok-secret');
    },
  );
});

describe('the confirmation is answered by Ctrl+Y alone, past the chord card`s guards', () => {
  const DELAYS = [250, 400, 516, 660, 1000, 1400, 1800] as const;
  const RATES = [30, 60, 100, 300, 450, 700, 1000, 1100, 1400, 1800] as const;
  const HELD_FOR_MS = 8000;
  /** When the host acknowledged the confirmation's frame, after the `Enter` that answered the field. */
  const ACK_MS = 16;
  const cases = (['Ctrl+Y', 'Enter'] as const).flatMap((held) =>
    (['legacy', 'kitty'] as const).map((mode) => [held, mode] as const),
  );

  it.each(cases)(
    'a held %s (%s repeats) from the Enter that answered the last field never starts the run; one patient Ctrl+Y after it is let go does',
    async (held, mode) => {
      const answered: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const r = rig({ 'one.yaml': ONE });
          const { opened } = await toFirstField(r);
          const t0 = await toConfirmation(r);
          const press: Key = held === 'Ctrl+Y' ? CTRL : ENTER;
          const input = held === 'Ctrl+Y' ? 'y' : '';
          // Pressed with the field's `Enter`, before the confirmation's frame was on screen: the host drops it, unseen.
          r.channel.ui.unseenInput(input, press);
          let shown = false;
          let last = t0;
          for (let time = t0 + delay; time <= t0 + HELD_FOR_MS; time += rate) {
            if (!shown && time >= t0 + ACK_MS) {
              r.at(t0 + ACK_MS);
              r.show();
              shown = true;
            }
            r.at(time);
            last = time;
            const repeat = mode === 'kitty' ? REPEAT(press) : press;
            if (shown) r.key(repeat, input);
            else r.channel.ui.unseenInput(input, repeat);
            if (r.snapshot().kind !== 'chord') {
              answered.push(`${String(delay)}/${String(rate)}`);
              break;
            }
          }
          expect(r.host.start, `${String(delay)}/${String(rate)}`).not.toHaveBeenCalled();
          if (!shown) r.show();
          // Let go, and press once after the lockout from the last repeat.
          r.at(last + APPROVAL_LOCKOUT_MS + 1);
          r.key(CTRL, 'y');
          expect(await opened, `the patient press after ${String(delay)}/${String(rate)}`).toMatch(
            /^Started one-field · run /u,
          );
          expect(r.host.start).toHaveBeenCalledTimes(1);
        }
      expect(answered).toEqual([]);
    },
  );

  it('a Ctrl+Y before the confirmation`s frame is on screen, or inside its dwell, answers nothing', async () => {
    const r = rig({ 'one.yaml': ONE });
    const { opened } = await toFirstField(r);
    await toConfirmation(r);
    r.key(CTRL, 'y'); // its frame was never acknowledged
    expect(r.snapshot().kind).toBe('chord');
    r.show();
    r.advance(100);
    r.key(CTRL, 'y'); // inside the dwell (and the lockout the early one restarted)
    expect(r.snapshot().kind).toBe('chord');
    r.advance(APPROVAL_LOCKOUT_MS + 1);
    r.key(CTRL, 'y');
    expect(await opened).toMatch(/^Started one-field · run /u);
  });

  it('an Enter, a letter or a paste never answers it; Ctrl+N cancels at once', async () => {
    const r = rig({ 'one.yaml': ONE });
    const { opened } = await toFirstField(r);
    await toConfirmation(r);
    r.show();
    r.advance(APPROVAL_LOCKOUT_MS + 1);
    r.key(ENTER);
    r.type('y');
    r.channel.ui.paste('y');
    expect(r.snapshot().kind).toBe('chord');
    r.key(CTRL, 'n');
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.host.start).not.toHaveBeenCalled();
  });
});

describe('a masked input, framed', () => {
  const SECRET = 'tok-LAUNCH-POPUP-SECRET-5d2c';

  it('is never in a snapshot; a resize empties it and says so; what is typed after it is what the run gets', async () => {
    const taken: Readonly<Record<string, string>>[] = [];
    const r = rig({ 'release.yaml': FORM }, async (request) => {
      taken.push((await request.secrets?.(['token'])) ?? {});
      return STARTED;
    });
    const { opened } = await toFirstField(r);
    await until(r, (s) => s.kind === 'text');
    r.type('v1');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'password');
    expect(r.snapshot().popup?.stepIndex, 'on the Inputs step').toBe(1);
    r.show();
    r.channel.ui.paste(SECRET);
    expect(r.snapshot().display).toBe('•'.repeat(Math.min(SECRET.length, 32)));
    r.channel.ui.resized();
    expect(r.snapshot()).toMatchObject({ display: '', error: NATIVE_PROMPT_RESIZED });
    // An `Enter` now submits nothing typed: the field is empty and required.
    r.key(ENTER);
    expect(r.snapshot().kind).toBe('password');
    r.channel.ui.paste('second');
    r.key(ENTER);
    await until(r, (s) => s.message.includes('draft'));
    r.key(ENTER);
    await until(r, (s) => s.kind === 'chord');
    r.show();
    r.advance(APPROVAL_LOCKOUT_MS + 1);
    r.key(CTRL, 'y');
    await opened;
    expect(taken).toEqual([{ token: 'second' }]);
    expect(JSON.stringify(r.snapshots), 'in no snapshot').not.toContain(SECRET);
    expect(JSON.stringify(r.snapshots)).not.toContain('second');
    expect(JSON.stringify(r.states), 'in no state of the machine').not.toContain('second');
  });
});

describe('every word a project wrote is scrubbed before it reaches the channel', () => {
  const ESC_CHAR = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CORPUS = [
    `${ESC_CHAR}[31mred${ESC_CHAR}[0m`,
    `${ESC_CHAR}]52;c;Zm9v${BEL}clip`,
    `${ESC_CHAR}]8;;https://evil.example${BEL}link`,
    `c1${String.fromCharCode(0x85, 0x9b)}[2J`,
    `bidi${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x2066)}x`,
    `zero${String.fromCharCode(0x200b)}width${String.fromCharCode(0x200d, 0xfeff)}`,
    `line${String.fromCharCode(0x2028)}sep${String.fromCharCode(0x2029)}para`,
    'Press Ctrl+Y now',
    '[Ctrl+Y] Start it · Esc close',
    String.fromCharCode(0xff3b, 0xff23, 0xff54, 0xff52, 0xff4c, 0xff0b, 0xff39, 0xff3d),
    `sk-ant-api03-${'A'.repeat(40)}`,
    'long '.repeat(80).trim(),
  ];
  /** A character a drawn row must not carry: a C0 control but the tab, DEL or a C1 control, a bidirectional control, a line separator. */
  const unsafe = (text: string): boolean =>
    Array.from(text).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x09) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0x200b ||
        code === 0x200d ||
        code === 0xfeff ||
        code === 0x2028 ||
        code === 0x2029
      );
    });
  /**
   * What the field takes of a text: it refuses a C0 or C1 control, DEL, a bidirectional control (round 2 sitting #2, F6: what the field could
   * not show as it is) and the zero-width and invisible characters the confirmation removes (the zero-width space, the word joiner, the
   * byte-order mark, the soft hyphen, the line and paragraph separators), so the person types the rest.
   */
  const typeable = (text: string): string =>
    Array.from(text)
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          code >= 0x20 &&
          !(code >= 0x7f && code <= 0x9f) &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069) &&
          code !== 0x200e &&
          code !== 0x200f &&
          code !== 0x061c &&
          code !== 0x200b &&
          code !== 0x2060 &&
          code !== 0xfeff &&
          code !== 0xad &&
          code !== 0x2028 &&
          code !== 0x2029
        );
      })
      .join('');
  /** Every text of a snapshot the popup draws: note, message, details, the options' labels and hints, the error. */
  const texts = (snapshot: NativePromptSnapshot): string[] => [
    snapshot.note,
    snapshot.message,
    ...snapshot.details,
    ...snapshot.options.flatMap((option) => [option.label, option.hint ?? '']),
    snapshot.error,
  ];

  it.each(CORPUS.map((text, index) => [index, text] as const))(
    'hostile text %i in the name, the path, an input`s description and default, a value typed and a server`s name',
    async (_index, hostile) => {
      const quoted = JSON.stringify(hostile);
      const yaml = `schema_version: '1.0'
workflow:
  id: hostile
  name: ${quoted}
  inputs:
    - { name: a, type: string, description: ${quoted}, default: ${quoted} }
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [read_file]
      mcp_servers:
        - { ref: ${quoted} }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: worker }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`;
      const r = rig({ [`.relavium/workflows/${hostile.slice(0, 40)}.yaml`]: yaml });
      const { opened } = await toFirstField(r);
      await until(r, (s) => s.kind === 'text');
      r.channel.ui.paste(typeable(hostile)); // what a person can type into the field
      r.key(ENTER);
      await until(r, (s) => s.kind === 'chord');
      for (const snapshot of r.snapshots)
        for (const text of texts(snapshot)) {
          expect(unsafe(text), JSON.stringify(text)).toBe(false);
          expect(text, 'no answer chord in a word the project wrote').not.toMatch(
            /Ctrl\+Y|ｃｔｒｌ/iu,
          );
          expect(text).not.toContain('sk-ant-api03-AAAA');
        }
      r.key(CTRL, 'c');
      expect(await opened).toBe(LAUNCH_CANCELLED);
    },
  );
});
