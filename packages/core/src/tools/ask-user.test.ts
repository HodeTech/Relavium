import { SESSION_ASK_BOUNDS, unwiredEffectJournal, type ToolPolicy } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ASK_USER_BOUNDS,
  ASK_USER_DESCRIPTION,
  ASK_USER_LLM_PARAMS,
  ASK_USER_OWN_ANSWER_GLYPH,
  AskUserAnswerSchema,
  AskUserArgsSchema,
  askUserDisplaySummaryOf,
  askUserRecord,
  buildAnsweredResult,
  notAskedResult,
  skippedResult,
  foldLabel,
  newAskUserTurnState,
  plainTextRefusal,
  type AskUserAnswer,
  type AskUserDelegate,
  type AskUserRequest,
} from './ask-user.js';
import { BUILTIN_TOOLS } from './builtins.js';
import { delegateAvailable } from './delegates.js';
import {
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolExecutionError,
  ToolUnavailableError,
} from './errors.js';
import { createToolRegistry } from './registry.js';
import { unwrapUntrusted, type Untrusted } from './untrusted.js';
import type {
  ToolCallPart,
  ToolDef,
  ToolDispatchContext,
  ToolLiveEvent,
  ToolResultPart,
} from './types.js';

/* --- helpers --- */

const OPTIONS = [
  { label: 'Alpha', description: 'The first choice' },
  { label: 'Beta', description: 'The second choice' },
];

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { header: 'Pick', question: 'Which one?', options: OPTIONS, ...overrides };
}

function args(...questions: Record<string, unknown>[]): unknown {
  return { questions: questions.length === 0 ? [question()] : questions };
}

function parse(value: unknown): AskUserRequest {
  return AskUserArgsSchema.parse(value);
}

function refused(value: unknown): boolean {
  return !AskUserArgsSchema.safeParse(value).success;
}

function call(value: unknown): ToolCallPart {
  return { type: 'tool_call', id: 'c1', name: 'ask_user', args: value };
}

function ctx(overrides: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set(['ask_user']),
    config: {},
    toolPolicy: {} satisfies ToolPolicy,
    fsScope: 'sandboxed',
    gateApproved: false,
    // The tool is not an effect: an unwired journal THROWS if anything tries to journal through it.
    effects: unwiredEffectJournal(),
    effectSlot: 0,
    ...overrides,
  };
}

function registry(): ReturnType<typeof createToolRegistry> {
  return createToolRegistry({ tools: BUILTIN_TOOLS, host: {} });
}

function answered(...selected: string[][]): AskUserAnswer {
  return { kind: 'answered', answers: selected.map((labels) => ({ selected: labels })) };
}

function resultOf(outcome: { toolResult: Untrusted<ToolResultPart> }): unknown {
  return unwrapUntrusted(outcome.toolResult).result;
}

/* --- the argument schema --- */

describe('the ceilings are the numbers the card was derived from (ADR-0132 §2)', () => {
  it('pins every ceiling as a LITERAL, so a change here cannot slip past tests that read the constant', () => {
    // The 80×24 card has nine body rows: header 1 + question ≤ 2 + options ≤ 4 + own row 1 + description 1. These numbers
    // are what make each part that size; `apps/cli/src/render/tui/question-card.test.ts` proves the layout for them. Change
    // one only together with the card and ADR-0132 §2.
    expect(ASK_USER_BOUNDS).toEqual({
      headerBytes: 24,
      questionBytes: 150,
      labelBytes: 60,
      descriptionBytes: 72,
      questionsPerCall: 4,
      optionsPerQuestion: 4,
      ownTextCodePoints: 500,
    });
  });
});

describe('ask_user arguments — bounds (ADR-0132 §2)', () => {
  it('accepts a minimal call and defaults multiSelect to false', () => {
    const parsed = parse(args());
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]?.multiSelect).toBe(false);
  });

  it.each([
    ['header', 'header', ASK_USER_BOUNDS.headerBytes],
    ['question', 'question', ASK_USER_BOUNDS.questionBytes],
  ])('the %s field takes exactly its byte limit and no more', (_name, field, limit) => {
    expect(refused(args(question({ [field]: 'a'.repeat(limit) })))).toBe(false);
    expect(refused(args(question({ [field]: 'a'.repeat(limit + 1) })))).toBe(true);
  });

  it('bounds the label and the description in bytes', () => {
    const option = (label: string, description: string) => [
      { label, description },
      { label: 'Other thing', description: 'x' },
    ];
    const l = ASK_USER_BOUNDS.labelBytes;
    const d = ASK_USER_BOUNDS.descriptionBytes;
    expect(refused(args(question({ options: option('a'.repeat(l), 'd') })))).toBe(false);
    expect(refused(args(question({ options: option('a'.repeat(l + 1), 'd') })))).toBe(true);
    expect(refused(args(question({ options: option('a', 'd'.repeat(d)) })))).toBe(false);
    expect(refused(args(question({ options: option('a', 'd'.repeat(d + 1)) })))).toBe(true);
  });

  it('counts BYTES, not characters: 50 three-byte letters fit a 150-byte question and 51 do not', () => {
    expect(refused(args(question({ question: '漢'.repeat(50) })))).toBe(false);
    expect(refused(args(question({ question: '漢'.repeat(51) })))).toBe(true);
  });

  it('takes one to four questions and two to four options', () => {
    expect(refused({ questions: [] })).toBe(true);
    expect(refused(args(question(), question(), question(), question()))).toBe(false);
    expect(refused(args(question(), question(), question(), question(), question()))).toBe(true);
    const opt = (n: number) => ({ label: `L${String(n)}`, description: 'd' });
    expect(refused(args(question({ options: [opt(1)] })))).toBe(true);
    expect(refused(args(question({ options: [opt(1), opt(2), opt(3), opt(4)] })))).toBe(false);
    expect(refused(args(question({ options: [opt(1), opt(2), opt(3), opt(4), opt(5)] })))).toBe(
      true,
    );
  });

  it('refuses unknown keys everywhere (strict)', () => {
    expect(refused({ ...(args() as object), extra: 1 })).toBe(true);
    expect(refused(args(question({ extra: 1 })))).toBe(true);
    expect(refused(args(question({ options: [{ ...OPTIONS[0], x: 1 }, OPTIONS[1]] })))).toBe(true);
  });
});

describe('ask_user arguments — plain text is refused, never repaired (ADR-0132 §2)', () => {
  it.each([
    ['a newline', 'two\nlines'],
    ['a tab', 'a\tb'],
    ['an escape sequence', 'red \u001b[31mtext'],
    ['an OSC hyperlink', '\u001b]8;;http://x\u0007link'],
    ['a carriage return', 'over\rwrite'],
    ['a bidirectional override', 'evil\u202etxt'],
    ['a zero-width space', 'zero\u200bwidth'],
    ['a joiner', 'a\u200db'],
    ['a byte-order mark', '\ufeffbom'],
    ['a tag character', 'tag\u{e0041}'],
    ['a line separator', 'a\u2028b'],
    ['a private-use code point', 'p\ue000q'],
    ['an unpaired surrogate', 'lone\ud800'],
    ['four stacked combining marks', 'x\u0302\u0303\u0304\u0305'],
    ['text that is not NFC', 'e\u0301'],
    ['leading whitespace', ' lead'],
    ['trailing whitespace', 'trail '],
    ['a blank string', '   '],
    ['an empty string', ''],
  ])('refuses %s in the question', (_name, text) => {
    expect(refused(args(question({ question: text })))).toBe(true);
  });

  it.each([
    '1. Yes',
    '2) No',
    '[x] Allow',
    '[ ] Pick',
    '[] Pick',
    '( ) Pick',
    '(x) Pick',
    '- item',
    '• item',
    '* item',
    '> item',
  ])('refuses a list or tick marker at the start: %s', (text) => {
    expect(refused(args(question({ question: text })))).toBe(true);
    expect(refused(args(question({ header: text })))).toBe(true);
    expect(
      refused(args(question({ options: [{ label: text, description: 'd' }, OPTIONS[1]] }))),
    ).toBe(true);
  });

  it.each([
    '1.5 GB',
    'Vec<String>',
    'plain words',
    'Emoji 😀 ok',
    'two  spaces',
    'a-b',
    '2024 plan',
    '3 files',
    'x [z] y',
  ])('accepts ordinary text that only resembles a marker: %s', (text) => {
    expect(refused(args(question({ question: text })))).toBe(false);
  });

  it('allows up to three stacked combining marks', () => {
    expect(plainTextRefusal('x\u0302\u0303\u0304', 150)).toBeUndefined();
  });

  it('exposes the refusal reason for the host to test against', () => {
    expect(plainTextRefusal('ok', 10)).toBeUndefined();
    expect(plainTextRefusal('a\nb', 10)).toMatch(/plain text/);
    expect(plainTextRefusal('abcdef', 3)).toMatch(/at most 3/);
  });
});

describe('ask_user arguments — labels (ADR-0132 §2)', () => {
  const withLabels = (a: string, b: string) =>
    args(
      question({
        options: [
          { label: a, description: 'd' },
          { label: b, description: 'd' },
        ],
      }),
    );

  it('refuses a duplicate label after trimming, NFC and case folding', () => {
    expect(refused(withLabels('Yes', 'yes'))).toBe(true);
    expect(refused(withLabels('Café', 'Cafe\u0301'))).toBe(true);
    expect(refused(withLabels('Yes', 'No'))).toBe(false);
  });

  it('folds without the ambient locale (Turkish dotted/dotless i do not collide)', () => {
    expect(foldLabel('I')).toBe('i');
    expect(foldLabel('ı')).toBe('ı');
    expect(refused(withLabels('I', 'ı'))).toBe(false);
  });

  it.each([
    'other',
    'Other',
    'OTHER',
    'Type your own answer',
    'Other (type your own answer)',
    `${ASK_USER_OWN_ANSWER_GLYPH} mine`,
  ])('reserves %s for the host row', (label) => {
    expect(refused(withLabels(label, 'Different'))).toBe(true);
  });

  it('does not reserve a label that merely contains the word', () => {
    expect(refused(withLabels('Other files', 'Others'))).toBe(false);
  });
});

describe('ask_user model-visible contract', () => {
  it('states the bounds, the no-Other rule, the no-secrets rule and the carry-forward rule', () => {
    expect(ASK_USER_DESCRIPTION).toContain(
      `at most ${String(ASK_USER_BOUNDS.questionBytes)} bytes`,
    );
    expect(ASK_USER_DESCRIPTION).toContain(`labels to ${String(ASK_USER_BOUNDS.labelBytes)}`);
    expect(ASK_USER_DESCRIPTION).toContain(
      `descriptions to ${String(ASK_USER_BOUNDS.descriptionBytes)}`,
    );
    expect(ASK_USER_DESCRIPTION).toContain(`headers to ${String(ASK_USER_BOUNDS.headerBytes)}`);
    expect(ASK_USER_DESCRIPTION).toContain('do not add an "Other" option');
    expect(ASK_USER_DESCRIPTION).toContain('Never ask for a password, token or other secret');
    expect(ASK_USER_DESCRIPTION).toContain('Do not use this to ask permission');
    expect(ASK_USER_DESCRIPTION).toContain('state any decision you rely on in your reply');
    expect(ASK_USER_DESCRIPTION).toContain('kept with the conversation');
    expect(ASK_USER_DESCRIPTION).not.toContain('do not see it');
  });

  it('advertises the same bounds in the JSON schema as the validator enforces', () => {
    const text = JSON.stringify(ASK_USER_LLM_PARAMS);
    for (const bound of [
      ASK_USER_BOUNDS.headerBytes,
      ASK_USER_BOUNDS.questionBytes,
      ASK_USER_BOUNDS.labelBytes,
      ASK_USER_BOUNDS.descriptionBytes,
    ])
      expect(text).toContain(`"maxLength":${String(bound)}`);
    expect(text).toContain(`"maxItems":${String(ASK_USER_BOUNDS.questionsPerCall)}`);
    expect(text).toContain(`"maxItems":${String(ASK_USER_BOUNDS.optionsPerQuestion)}`);
  });

  it('is a built-in that needs the askUser delegate, is not governed, journals nothing and has no preview', () => {
    const def = BUILTIN_TOOLS.find((tool) => tool.id === 'ask_user');
    expect(def).toBeDefined();
    expect(def?.requiresDelegate).toBe('askUser');
    expect(def?.policy).toEqual({
      fsScoped: false,
      spawnsProcess: false,
      requiresGateApproval: false,
    });
    expect(def?.effect).toBeUndefined();
    expect(def?.preview).toBeUndefined();
    expect(def?.prepare).toBeUndefined();
    expect(def?.displaySummary).toBeDefined();
  });
});

/* --- the answer --- */

describe('ask_user answers (ADR-0132 §3, contract "Delegate")', () => {
  const request = parse(
    args(question({ multiSelect: true }), question({ header: 'Second', question: 'Again?' })),
  );
  const good = (): AskUserAnswer => ({
    kind: 'answered',
    answers: [{ selected: ['Alpha', 'Beta'] }, { selected: ['Beta'] }],
  });
  const asAnswered = (answer: AskUserAnswer) => {
    if (answer.kind !== 'answered') throw new Error('fixture');
    return answer;
  };

  it('builds one entry per question, with the header, in order', () => {
    expect(buildAnsweredResult(request, asAnswered(good()))).toEqual({
      status: 'answered',
      answers: [
        { header: 'Pick', selected: ['Alpha', 'Beta'] },
        { header: 'Second', selected: ['Beta'] },
      ],
    });
  });

  it.each([
    ['the wrong number of answers', { kind: 'answered', answers: [{ selected: ['Alpha'] }] }],
    [
      'an option that was not offered',
      { kind: 'answered', answers: [{ selected: ['Nope'] }, { selected: ['Beta'] }] },
    ],
    [
      'an option named twice',
      { kind: 'answered', answers: [{ selected: ['Alpha', 'Alpha'] }, { selected: ['Beta'] }] },
    ],
    [
      'a multi-select with nothing',
      { kind: 'answered', answers: [{ selected: [] }, { selected: ['Beta'] }] },
    ],
    [
      'a single-select with nothing',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [] }] },
    ],
    [
      'a single-select with two labels',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: ['Alpha', 'Beta'] }] },
    ],
    [
      'a single-select with a label AND text',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: ['Beta'], other: 'x' }] },
    ],
    [
      'empty own text',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [], other: '' }] },
    ],
    [
      'blank own text',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [], other: '   ' }] },
    ],
    [
      'own text with a newline',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [], other: 'a\nb' }] },
    ],
    [
      'own text with a control character',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [], other: 'a\u001bb' }] },
    ],
    [
      'own text with a line separator',
      { kind: 'answered', answers: [{ selected: ['Alpha'] }, { selected: [], other: 'a\u2028b' }] },
    ],
  ] satisfies [string, AskUserAnswer][])('refuses %s as a host fault', (_name, answer) => {
    expect(() => buildAnsweredResult(request, asAnswered(answer))).toThrow();
  });

  it('accepts own text on its own for either kind of question, and a label plus text in a multi-select', () => {
    const own = (selected: string[], other: string): AskUserAnswer => ({
      kind: 'answered',
      answers: [{ selected, other }, { selected: ['Alpha'] }],
    });
    expect(buildAnsweredResult(request, asAnswered(own([], 'my own')))).toMatchObject({
      answers: [{ selected: [], other: 'my own' }, {}],
    });
    expect(buildAnsweredResult(request, asAnswered(own(['Beta'], 'and more')))).toMatchObject({
      answers: [{ selected: ['Beta'], other: 'and more' }, {}],
    });
  });

  it('holds the person’s own text to 500 CODE POINTS, counting an astral character once', () => {
    const own = (other: string): AskUserAnswer => ({
      kind: 'answered',
      answers: [{ selected: [], other }, { selected: ['Alpha'] }],
    });
    const limit = ASK_USER_BOUNDS.ownTextCodePoints;
    expect(() => buildAnsweredResult(request, asAnswered(own('😀'.repeat(limit))))).not.toThrow();
    expect(() => buildAnsweredResult(request, asAnswered(own('😀'.repeat(limit + 1))))).toThrow();
  });

  it('masks a secret-shaped run in the person’s own text in the engine, so every surface gets the backstop', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const result = buildAnsweredResult(
      request,
      asAnswered({
        kind: 'answered',
        answers: [{ selected: [], other: `use ${token} please` }, { selected: ['Alpha'] }],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain('[redacted]');
  });
});

describe('ask_user display summary — content-free (ADR-0132 §6)', () => {
  it.each([
    [{ status: 'answered', answers: [{ header: 'h', selected: ['x'] }] }, 'answered 1 question'],
    [
      {
        status: 'answered',
        answers: [
          { header: 'h', selected: [] },
          { header: 'i', selected: [] },
        ],
      },
      'answered 2 questions',
    ],
    [{ status: 'skipped', message: 'm' }, 'skipped'],
    [{ status: 'not_asked', reason: 'skipped_earlier', message: 'm' }, 'not asked'],
  ])('maps %j to %s', (result, summary) => {
    expect(askUserDisplaySummaryOf(result)).toBe(summary);
  });

  it.each([undefined, null, 'text', 7, [], {}, { status: 'unknown' }, { status: 'answered' }])(
    'gives a fixed phrase for anything that is not its own result: %j',
    (value) => {
      expect(askUserDisplaySummaryOf(value)).toBe('completed');
    },
  );

  it('never echoes the words it was given', () => {
    const summary = askUserDisplaySummaryOf({
      status: 'answered',
      answers: [{ header: 'SECRET-HEADER', selected: ['SECRET-LABEL'], other: 'SECRET-OWN' }],
    });
    expect(summary).not.toMatch(/SECRET/);
  });
});

/* --- dispatch through the registry --- */

describe('ask_user dispatch (ADR-0132 §1, §4, §5)', () => {
  function wired(delegate: AskUserDelegate, overrides: Partial<ToolDispatchContext> = {}) {
    const state = newAskUserTurnState();
    return { state, context: ctx({ askUser: delegate, askUserTurn: state, ...overrides }) };
  }

  it('without a delegate is the typed unavailable error', async () => {
    await expect(registry().dispatch(call(args()), ctx())).rejects.toBeInstanceOf(
      ToolUnavailableError,
    );
  });

  it('a delegate without the per-turn state is a wiring fault: fatal and not retryable', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' }));
    const error = await registry()
      .dispatch(call(args()), ctx({ askUser: delegate }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).retryable).toBe(false);
    expect((error as ToolExecutionError).recoverable).toBe(false);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('refuses an invalid call before the delegate runs and counts it for nothing', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve(answered(['Alpha'])));
    const { state, context } = wired(delegate);
    await expect(
      registry().dispatch(call(args(question({ question: 'two\nlines' }))), context),
    ).rejects.toBeInstanceOf(ToolArgsInvalidError);
    expect(delegate).not.toHaveBeenCalled();
    expect(state.skipped).toBe(false);
  });

  it('returns the answer as a successful result and hands the delegate the VALIDATED request and the signal', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve(answered(['Beta'])));
    const controller = new AbortController();
    const { state, context } = wired(delegate, { signal: controller.signal });
    const outcome = await registry().dispatch(call(args()), context);
    expect(resultOf(outcome)).toEqual({
      status: 'answered',
      answers: [{ header: 'Pick', selected: ['Beta'] }],
    });
    expect(unwrapUntrusted(outcome.toolResult).isError).toBeUndefined();
    expect(state).toEqual({ skipped: false });
    const [request, signal] = delegate.mock.calls[0] ?? [];
    expect(request?.questions[0]?.multiSelect).toBe(false); // the default was applied
    expect(signal).toBe(controller.signal);
  });

  it('keeps the person’s words out of every event: the summary is a closed phrase, and so is the live observer’s', async () => {
    const words = 'TELL-NOBODY-THIS-PHRASE';
    const live: ToolLiveEvent[] = [];
    const delegate: AskUserDelegate = () =>
      Promise.resolve({ kind: 'answered', answers: [{ selected: [], other: words }] });
    const { context } = wired(delegate, { onToolLiveEvent: (event) => live.push(event) });
    const outcome = await registry().dispatch(call(args()), context);
    // The model DOES receive the words — they are the answer.
    expect(JSON.stringify(resultOf(outcome))).toContain(words);
    // Nothing else does.
    expect(outcome.events.result.outputSummary).toBe('answered 1 question');
    const completed = live.find((event) => event.phase === 'completed');
    expect(completed?.phase === 'completed' ? completed.summary : undefined).toBe(
      'answered 1 question',
    );
    expect(JSON.stringify(live)).not.toContain(words);
    expect(live.some((event) => event.phase === 'preview')).toBe(false); // no preview ⇒ a name-only row
  });

  it('a skip is a successful result and closes questions for the rest of the turn, with no card', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' }));
    const { state, context } = wired(delegate);
    const first = await registry().dispatch(call(args()), context);
    expect(resultOf(first)).toMatchObject({ status: 'skipped' });
    expect(unwrapUntrusted(first.toolResult).isError).toBeUndefined();
    expect(first.events.result.outputSummary).toBe('skipped');
    expect(state.skipped).toBe(true);
    const second = await registry().dispatch(call(args()), context);
    expect(resultOf(second)).toMatchObject({ status: 'not_asked', reason: 'skipped_earlier' });
    expect(second.events.result.outputSummary).toBe('not asked');
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('has NO per-turn card ceiling: as many questions as the task needs, and only a skip closes them', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve(answered(['Alpha'])));
    const { state, context } = wired(delegate);
    for (let n = 0; n < 40; n += 1)
      expect(resultOf(await registry().dispatch(call(args()), context))).toMatchObject({
        status: 'answered',
      });
    expect(delegate).toHaveBeenCalledTimes(40);
    expect(state).toEqual({ skipped: false });
  });

  it('a fresh turn state is open again after a skip (the state is the turn’s, not the tool’s)', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' }));
    const turnOne = wired(delegate);
    await registry().dispatch(call(args()), turnOne.context);
    expect(resultOf(await registry().dispatch(call(args()), turnOne.context))).toMatchObject({
      status: 'not_asked',
    });
    const turnTwo = wired(delegate);
    expect(resultOf(await registry().dispatch(call(args()), turnTwo.context))).toMatchObject({
      status: 'skipped',
    });
  });

  it('a stop is a cancel: a delegate that rejects with an AbortError is routed to the cancel path', async () => {
    const abort = Object.assign(new Error('stopped'), { name: 'AbortError' });
    const { context } = wired(() => Promise.reject(abort));
    await expect(registry().dispatch(call(args()), context)).rejects.toBeInstanceOf(
      ToolCancelledError,
    );
  });

  it('a stop is a cancel even when the delegate rejects with a plain error after the signal fired', async () => {
    const controller = new AbortController();
    const { context } = wired(
      () => {
        controller.abort();
        return Promise.reject(new Error('whatever'));
      },
      { signal: controller.signal },
    );
    await expect(registry().dispatch(call(args()), context)).rejects.toBeInstanceOf(
      ToolCancelledError,
    );
  });

  it('any other delegate failure is fatal and NOT retryable, and its message does not reach the model', async () => {
    const { context } = wired(() => Promise.reject(new Error('internal path /Users/x/secret')));
    const error = await registry()
      .dispatch(call(args()), context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).retryable).toBe(false);
    expect((error as ToolExecutionError).recoverable).toBe(false);
    expect((error as ToolExecutionError).message).not.toContain('/Users/x');
  });

  it('a synchronous throw from the delegate is the same fatal fault', async () => {
    const { context } = wired(() => {
      throw new Error('boom');
    });
    const error = await registry()
      .dispatch(call(args()), context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).retryable).toBe(false);
  });

  it('a malformed answer from the host is the same fatal fault, not a result for the model', async () => {
    const { context } = wired(() => Promise.resolve(answered(['Not an option'])));
    const error = await registry()
      .dispatch(call(args()), context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).retryable).toBe(false);
    expect((error as ToolExecutionError).recoverable).toBe(false);
  });

  it('an answer of an unknown kind is a host fault', async () => {
    const hostile = (): Promise<AskUserAnswer> =>
      Promise.resolve(JSON.parse('{"kind":"approved"}') as AskUserAnswer);
    const { context } = wired(hostile);
    const error = await registry()
      .dispatch(call(args()), context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    // Fatal AND not retryable: a registry-wrapped stray TypeError would be `recoverable` for an ungoverned tool, which on a
    // chat surface feeds the failure back to the model and lets it reopen the card.
    expect((error as ToolExecutionError).retryable).toBe(false);
    expect((error as ToolExecutionError).recoverable).toBe(false);
  });

  it('is not governed: the approval hook is never consulted, whatever the regime, and nothing is journaled', async () => {
    const confirm = vi.fn(() => Promise.resolve({ outcome: 'reject' as const }));
    const emitApprovalRequested = vi.fn();
    const { context } = wired(() => Promise.resolve(answered(['Alpha'])), {
      approval: { confirm, emitApprovalRequested },
    });
    const outcome = await registry().dispatch(call(args()), context);
    expect(resultOf(outcome)).toMatchObject({ status: 'answered' });
    expect(confirm).not.toHaveBeenCalled();
    expect(emitApprovalRequested).not.toHaveBeenCalled();
  });

  it('an answer touches no approval state: a result, a cache entry and a permission are different things', async () => {
    const onDispatchSucceeded = vi.fn();
    const { context } = wired(() => Promise.resolve(answered(['Alpha'])), {
      approval: { confirm: () => Promise.resolve({ outcome: 'approve', onDispatchSucceeded }) },
    });
    await registry().dispatch(call(args()), context);
    expect(onDispatchSucceeded).not.toHaveBeenCalled();
  });
});

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('the host draws column 0 — model text cannot forge its rows, ticks or keys (ADR-0132 §2, security sitting)', () => {
  // A question is hard-wrapped at 78 columns, so a forged row can start at ANY byte of it; the refusals therefore apply
  // anywhere in the string, not only at its start.
  it.each([
    ['the cursor glyph and a chosen tick', '› 1 (•) Approve'],
    ['a chosen tick shape in the middle of a line', 'Keep my config 1 (•) Overwrite config.toml'],
    ['an empty tick shape', 'Pick 2 ( ) Keep it'],
    ['a checked box', 'Todo [x] done'],
    ['an empty box', 'Todo [ ] open'],
    ['the own-answer glyph', '✎ Type your own answer…'],
    ['the field block cursor', 'type here █'],
    ['a rule made of box-drawing characters', '─ Approval needed ─'],
    ['a vertical box-drawing bar', '│ looks like a gutter'],
    ['an approval key token', '[y] approve once'],
    ['another approval key token', 'press [a] for always'],
    ['an uppercase key token', 'then [N] to deny'],
  ])('refuses %s anywhere in a header, question, label or description', (_name, text) => {
    expect(refused(args(question({ question: text })))).toBe(true);
    expect(refused(args(question({ header: text })))).toBe(true);
    expect(
      refused(args(question({ options: [{ label: 'ok', description: text }, OPTIONS[1]] }))),
    ).toBe(true);
    expect(
      refused(args(question({ options: [{ label: text, description: 'd' }, OPTIONS[1]] }))),
    ).toBe(true);
  });

  it('accepts brackets and parentheses that are not the host’s shapes', () => {
    for (const text of ['arr[i] is fine', 'f(x) and g(y)', 'Use [z] here', 'a (b) c'])
      expect(refused(args(question({ question: text })))).toBe(false);
  });
});

describe('invisible and look-alike characters are refused (ADR-0132 §2, security sitting)', () => {
  it.each([
    ['a Hangul filler', `Yes${cp(0x3164)}`],
    ['a half-width Hangul filler', `Yes${cp(0xffa0)}`],
    ['a Hangul choseong filler', `Yes${cp(0x115f)}`],
    ['a combining grapheme joiner', `Yes${cp(0x034f)}`],
    ['a variation selector after a letter', `Yes${cp(0xfe0f)}`],
    ['a Mongolian free variation selector', `Yes${cp(0x180b)}`],
    ['a braille blank', `Yes${cp(0x2800)}`],
    ['a no-break space', `Type${cp(0x00a0)}your own answer`],
    ['an ideographic space', `a${cp(0x3000)}b`],
    ['a thin space', `a${cp(0x2009)}b`],
  ])('refuses %s', (_name, text) => {
    expect(refused(args(question({ question: text })))).toBe(true);
  });

  it('a blank-looking header is refused', () => {
    expect(refused(args(question({ header: cp(0x3164) })))).toBe(true);
    expect(refused(args(question({ header: cp(0x2800) })))).toBe(true);
  });

  it('keeps a variation selector that makes an emoji an emoji', () => {
    expect(plainTextRefusal(`Love ${cp(0x2764, 0xfe0f)} it`, 150)).toBeUndefined();
    expect(plainTextRefusal(`Nice ${cp(0x1f44d)}`, 150)).toBeUndefined();
  });

  it('refuses one character built from many code points — a 50-jamo Hangul run is ONE grapheme and 100 columns wide', () => {
    expect(plainTextRefusal(cp(...Array<number>(50).fill(0x1100)), 150)).toMatch(
      /many code points/,
    );
    expect(
      plainTextRefusal(`Keep it? ${cp(...Array<number>(44).fill(0x1100))} ok`, 150),
    ).toBeDefined();
  });

  it('admits ordinary multi-code-point characters: a keycap, a flag, a letter with up to three marks', () => {
    expect(plainTextRefusal(`Press 1${cp(0xfe0f, 0x20e3)}`, 150)).toBeUndefined();
    expect(plainTextRefusal(`Türkiye ${cp(0x1f1f9, 0x1f1f7)}`, 150)).toBeUndefined();
    expect(plainTextRefusal(`x${cp(0x302, 0x303, 0x304)}`, 150)).toBeUndefined();
  });

  it('labels that differ only by whitespace spelling are the same label, and the host row’s words are reserved across spacing', () => {
    expect(foldLabel('Type  your   own answer')).toBe('type your own answer');
    expect(
      refused(
        args(
          question({ options: [{ label: 'Type  your own answer', description: 'd' }, OPTIONS[1]] }),
        ),
      ),
    ).toBe(true);
    expect(
      refused(
        args(
          question({
            options: [
              { label: 'a  b', description: 'd' },
              { label: 'A B', description: 'd' },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe('what a host may hand back (ADR-0132 §4)', () => {
  const dispatchWith = (returned: unknown) => {
    const context = ctx({
      askUser: () => returned as Promise<AskUserAnswer>,
      askUserTurn: newAskUserTurnState(),
    });
    return registry()
      .dispatch(call(args()), context)
      .catch((e: unknown) => e);
  };

  it.each([
    ['null', Promise.resolve(null)],
    ['a bare kind', Promise.resolve({ kind: 'answered' })],
    ['a null answer entry', Promise.resolve({ kind: 'answered', answers: [null] })],
    ['an entry with no selection', Promise.resolve({ kind: 'answered', answers: [{}] })],
    [
      'own text that is not a string',
      Promise.resolve({ kind: 'answered', answers: [{ selected: [], other: 5 }] }),
    ],
    [
      'a selection that is a string',
      Promise.resolve({ kind: 'answered', answers: [{ selected: 'Alpha' }] }),
    ],
    ['an extra key', Promise.resolve({ kind: 'skipped', note: 'x' })],
    ['not a promise at all', 'answered'],
  ])('%s is a host fault: fatal, not recoverable, not retryable', async (_name, returned) => {
    const error = await dispatchWith(returned);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).retryable).toBe(false);
    expect((error as ToolExecutionError).recoverable).toBe(false);
  });

  it('the shape check itself accepts exactly the two documented answers', () => {
    expect(AskUserAnswerSchema.safeParse({ kind: 'skipped' }).success).toBe(true);
    expect(
      AskUserAnswerSchema.safeParse({
        kind: 'answered',
        answers: [{ selected: ['a'], other: 'b' }],
      }).success,
    ).toBe(true);
    expect(AskUserAnswerSchema.safeParse({ kind: 'declined' }).success).toBe(false);
  });
});

describe('the display-summary hook is for first-party results only (ADR-0132 §6)', () => {
  const hooked = (source: 'builtin' | 'mcp', summary: () => string): ToolDef => ({
    id: 'probe_tool',
    source,
    description: 'a probe',
    parseArgs: () => ({}),
    llmVisibleParams: { type: 'object', properties: {}, additionalProperties: false },
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    displaySummary: summary,
    dispatch: () => Promise.resolve({ secret: 'THE-PERSONS-WORDS' }),
  });
  const run = (def: ToolDef) =>
    createToolRegistry({ tools: [def], host: {} }).dispatch(
      { type: 'tool_call', id: 'c', name: 'probe_tool', args: {} },
      ctx({ grantedToolIds: new Set(['probe_tool']) }),
    );

  it('a built-in hook replaces the derived summary', async () => {
    expect(
      (await run(hooked('builtin', () => 'a closed phrase'))).events.result.outputSummary,
    ).toBe('a closed phrase');
  });

  it('a hook that THROWS yields a fixed phrase, never the exception text', async () => {
    const outcome = await run(
      hooked('builtin', () => {
        throw new Error('THE-PERSONS-WORDS leaked via the exception');
      }),
    );
    expect(outcome.events.result.outputSummary).toBe('completed');
  });

  it.each([
    ['too long', 'x'.repeat(65)],
    ['multi-line', 'two\nlines'],
    ['non-ASCII', 'café'],
    ['empty', ''],
  ])('a hook result that is %s is not shown', async (_name, summary) => {
    expect((await run(hooked('builtin', () => summary))).events.result.outputSummary).toBe(
      'completed',
    );
  });

  it('a non-built-in tool cannot replace the masked, bounded summary with its own text', async () => {
    const outcome = await run(hooked('mcp', () => 'chosen by the server'));
    expect(outcome.events.result.outputSummary).not.toBe('chosen by the server');
  });
});

describe('both delegate fields gate the offer (ADR-0132 §1, CR-73)', () => {
  const askDef = BUILTIN_TOOLS.find((tool) => tool.id === 'ask_user');
  it('is offered only when the delegate AND the per-turn state are both present', () => {
    if (askDef === undefined) throw new Error('missing built-in');
    const delegate: AskUserDelegate = () => Promise.resolve({ kind: 'skipped' });
    expect(delegateAvailable(askDef, {})).toBe(false);
    expect(delegateAvailable(askDef, { askUser: delegate })).toBe(false);
    expect(delegateAvailable(askDef, { askUserTurn: newAskUserTurnState() })).toBe(false);
    expect(
      delegateAvailable(askDef, { askUser: delegate, askUserTurn: newAskUserTurnState() }),
    ).toBe(true);
  });
});

describe('the model-facing description (ADR-0132 §6)', () => {
  it('is pinned word for word', () => {
    expect(ASK_USER_DESCRIPTION).toBe(
      'Ask the user a question only they can answer: a choice between real alternatives, a preference, or a requirement you cannot find by reading files. Give two to four options with a short description each; do not add an "Other" option, because the user can always type their own answer. Ask up to four related questions in one call. Keep each question to at most 150 bytes, labels to 60, descriptions to 72 and headers to 24, in plain text with no control characters. Do not start any of them with a list marker such as `1.`, `-`, `>` or `[x]`, and do not use box-drawing or tick glyphs, `[y]`-style key tokens, zero-width or invisible characters, leading or trailing spaces, or non-NFC text. Never ask for a password, token or other secret. Do not use this to ask permission: approval of writes and commands is requested by the system, and an answer here changes no permission. Your question and the answer are kept with the conversation, so later turns can refer back to them (a long answer may be shortened); still state any decision you rely on in your reply.',
    );
  });
});

describe('the question record a call leaves in the session (ADR-0133)', () => {
  const request = (...questions: Record<string, unknown>[]): AskUserRequest =>
    parse(args(...questions));
  const multi = (overrides: Record<string, unknown> = {}) =>
    question({ multiSelect: true, header: 'Many', question: 'Which ones?', ...overrides });

  it("pins the stored ceilings to the tool's own argument bounds", () => {
    expect(SESSION_ASK_BOUNDS).toMatchObject({
      headerBytes: ASK_USER_BOUNDS.headerBytes,
      questionBytes: ASK_USER_BOUNDS.questionBytes,
      labelBytes: ASK_USER_BOUNDS.labelBytes,
      questionsPerRecord: ASK_USER_BOUNDS.questionsPerCall,
      optionsPerQuestion: ASK_USER_BOUNDS.optionsPerQuestion,
      ownTextCodePoints: ASK_USER_BOUNDS.ownTextCodePoints,
    });
  });

  it('records each question with its answer, the header and question as asked', () => {
    const asked = request(question(), multi());
    const result = buildAnsweredResult(asked, {
      kind: 'answered',
      answers: [{ selected: ['Beta'] }, { selected: ['Alpha'], other: 'and a third' }],
    });
    expect(askUserRecord(asked, result)).toEqual({
      status: 'answered',
      items: [
        { header: 'Pick', question: 'Which one?', selected: ['Beta'] },
        { header: 'Many', question: 'Which ones?', selected: ['Alpha'], other: 'and a third' },
      ],
    });
  });

  it('lists the chosen labels in the ORDER THE QUESTION OFFERED THEM, whatever order the host sent', () => {
    const asked = request(multi());
    const result = buildAnsweredResult(asked, {
      kind: 'answered',
      answers: [{ selected: ['Beta', 'Alpha'] }],
    });
    expect(askUserRecord(asked, result)).toMatchObject({
      items: [{ selected: ['Alpha', 'Beta'] }],
    });
  });

  it('records an own-text-only answer with an empty choice list', () => {
    const asked = request(question());
    const result = buildAnsweredResult(asked, {
      kind: 'answered',
      answers: [{ selected: [], other: '  my own words  ' }],
    });
    expect(askUserRecord(asked, result)).toEqual({
      status: 'answered',
      items: [{ header: 'Pick', question: 'Which one?', selected: [], other: 'my own words' }],
    });
  });

  it('records the text the model received — masked — never the raw one', () => {
    const asked = request(question());
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const result = buildAnsweredResult(asked, {
      kind: 'answered',
      answers: [{ selected: [], other: `use key ${secret}` }],
    });
    const record = askUserRecord(asked, result);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).toContain('[redacted]');
  });

  it('clips masked text that grew past the stored ceiling instead of dropping the record', () => {
    const asked = request(question());
    const result = {
      status: 'answered' as const,
      answers: [
        { header: 'Pick', selected: [], other: 'x'.repeat(ASK_USER_BOUNDS.ownTextCodePoints + 25) },
      ],
    };
    const record = askUserRecord(asked, result);
    expect([...(record?.items[0]?.other ?? '')]).toHaveLength(ASK_USER_BOUNDS.ownTextCodePoints);
  });

  it('drops an empty own-text field and keeps the choice made with it', () => {
    const asked = request(question());
    const record = askUserRecord(asked, {
      status: 'answered',
      answers: [{ header: 'Pick', selected: ['Alpha'], other: '' }],
    });
    expect(record).toEqual({
      status: 'answered',
      items: [{ header: 'Pick', question: 'Which one?', selected: ['Alpha'] }],
    });
  });

  it('records a skip as the questions asked, and a call that showed no card as nothing', () => {
    const asked = request(question(), multi());
    expect(askUserRecord(asked, skippedResult())).toEqual({
      status: 'skipped',
      items: [
        { header: 'Pick', question: 'Which one?' },
        { header: 'Many', question: 'Which ones?' },
      ],
    });
    expect(askUserRecord(asked, notAskedResult('skipped_earlier'))).toBeUndefined();
  });

  it("is total: anything that is not this tool's result, or does not match the request, records nothing", () => {
    const asked = request(question());
    for (const junk of [
      undefined,
      null,
      7,
      'answered',
      [],
      {},
      { status: 'answered' },
      { status: 'nope' },
    ])
      expect(askUserRecord(asked, junk)).toBeUndefined();
    // An answer count that does not match the questions asked.
    expect(askUserRecord(asked, { status: 'answered', answers: [] })).toBeUndefined();
    expect(
      askUserRecord(asked, {
        status: 'answered',
        answers: [
          { header: 'Pick', selected: ['Alpha'] },
          { header: 'Pick', selected: ['Alpha'] },
        ],
      }),
    ).toBeUndefined();
    // An answered item with neither a choice nor text is not an answer.
    expect(
      askUserRecord(asked, { status: 'answered', answers: [{ header: 'Pick', selected: [] }] }),
    ).toBeUndefined();
  });

  it('rides the dispatch outcome for an answered and a skipped call, and not for one that showed no card', async () => {
    const state = newAskUserTurnState();
    const delegate: AskUserDelegate = () => Promise.resolve(answered(['Beta']));
    const context = ctx({ askUser: delegate, askUserTurn: state });
    const outcome = await registry().dispatch(call(args()), context);
    expect(outcome.ask).toEqual({
      status: 'answered',
      items: [{ header: 'Pick', question: 'Which one?', selected: ['Beta'] }],
    });
    state.skipped = true;
    expect((await registry().dispatch(call(args()), context)).ask).toBeUndefined();
    const skipper = ctx({
      askUser: () => Promise.resolve({ kind: 'skipped' }),
      askUserTurn: newAskUserTurnState(),
    });
    expect((await registry().dispatch(call(args()), skipper)).ask).toMatchObject({
      status: 'skipped',
    });
  });

  it('never rides an event: the call and result events stay content-free', async () => {
    const words = 'ONLY-IN-THE-TYPED-HISTORY';
    const context = ctx({
      askUser: () =>
        Promise.resolve({ kind: 'answered', answers: [{ selected: [], other: words }] }),
      askUserTurn: newAskUserTurnState(),
    });
    const outcome = await registry().dispatch(call(args()), context);
    expect(outcome.ask?.items[0]?.other).toBe(words);
    expect(JSON.stringify(outcome.events)).not.toContain(words);
  });
});

describe('the question-record hook is for first-party tools only (ADR-0133)', () => {
  const hooked = (source: 'builtin' | 'mcp', record: () => unknown): ToolDef =>
    ({
      id: 'probe_tool',
      source,
      description: 'a probe',
      parseArgs: () => ({}),
      llmVisibleParams: { type: 'object', properties: {}, additionalProperties: false },
      policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
      askRecord: record,
      dispatch: () => Promise.resolve({ ok: true }),
    }) as unknown as ToolDef;
  const run = (def: ToolDef) =>
    createToolRegistry({ tools: [def], host: {} }).dispatch(
      { type: 'tool_call', id: 'c', name: 'probe_tool', args: {} },
      ctx({ grantedToolIds: new Set(['probe_tool']) }),
    );
  const valid = { status: 'skipped', items: [{ header: 'H', question: 'Q?' }] };

  it("a built-in hook's valid record rides the outcome", async () => {
    expect((await run(hooked('builtin', () => valid))).ask).toEqual(valid);
  });

  it('a non-built-in tool cannot attach a record, valid or not', async () => {
    expect((await run(hooked('mcp', () => valid))).ask).toBeUndefined();
  });

  it('a hook that throws costs the record and nothing else', async () => {
    const outcome = await run(
      hooked('builtin', () => {
        throw new Error('boom');
      }),
    );
    expect(outcome.ask).toBeUndefined();
    expect(unwrapUntrusted(outcome.toolResult).result).toEqual({ ok: true });
  });

  it.each([
    ['not an object', 'x'],
    [
      'over the byte ceiling',
      { status: 'skipped', items: [{ header: 'h'.repeat(25), question: 'Q?' }] },
    ],
    [
      'carrying a control character',
      { status: 'skipped', items: [{ header: 'H', question: 'a\nb' }] },
    ],
    ['an unknown field', { ...valid, extra: 1 }],
  ])('a record that is %s is dropped, not stored', async (_name, record) => {
    expect((await run(hooked('builtin', () => record))).ask).toBeUndefined();
  });
});
