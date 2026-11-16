/**
 * The `ask_user` tool's engine-pure parts — its argument schema, the delegate contract, the per-turn state, the
 * fixed model-facing texts and the answer validation ([ADR-0132](../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md);
 * the contract is [built-in-tools.md](../../../../docs/reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d)).
 *
 * Everything here is a pure function or a type: the card, the keyboard and the terminal belong to the host, which
 * supplies the {@link AskUserDelegate}. Nothing in this module is a security decision about the PERSON'S answer —
 * an answer is data for the model and never consent (ADR-0132 §6) — but the model-authored text it validates is a
 * new terminal sink, so the rules below REFUSE what they cannot show faithfully rather than repair it.
 */

import {
  SessionAskRecordSchema,
  utf8ByteLength,
  type AbortSignalLike,
  type SessionAskRecord,
} from '@relavium/shared';
import { z } from 'zod';

import { redactSecretShapedText } from './bounding.js';
import type { JsonSchema } from './types.js';

/** The ceilings, in UTF-8 bytes, derived from the 80×24 card (ADR-0132 §2): a code point is never wider in columns than in bytes. */
export const ASK_USER_BOUNDS = {
  headerBytes: 24,
  questionBytes: 150,
  labelBytes: 60,
  descriptionBytes: 72,
  questionsPerCall: 4,
  optionsPerQuestion: 4,
  /** The person's own text — one line, in code points. */
  ownTextCodePoints: 500,
} as const;

/** The host's own last row; no model label may stand in for it (ADR-0132 §2). */
export const ASK_USER_OWN_ANSWER_GLYPH = '✎';

/* ------------------------------------------------------------------------------------------------ *
 * Argument schema — refuse, never repair.
 * ------------------------------------------------------------------------------------------------ */

// Control (ESC included, so every terminal sequence, and a newline or a tab), format (bidirectional controls,
// zero-width characters and joiners, tag characters, the byte-order mark), line and paragraph separators,
// private-use, unassigned and unpaired-surrogate code points.
const FORBIDDEN_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/u;
// Invisible or zero-width code points that are NOT format characters (Hangul filler, combining grapheme joiner, variation
// selectors, Mongolian free variation selectors, …): `string-width` counts them 0 columns while a terminal may draw them wide,
// and two labels differing only by one render identically. A variation selector-16 after a pictographic base is what makes an
// emoji an emoji, so exactly that is admitted. The braille blank is not default-ignorable but draws as nothing.
const EMOJI_PRESENTATION = new RegExp(
  `(?<=\\p{Extended_Pictographic})${String.fromCodePoint(0xfe0f)}|${String.fromCodePoint(0xfe0f)}(?=${String.fromCodePoint(0x20e3)})`,
  'gu',
);
const INVISIBLE_LETTER = new RegExp(
  `[\\p{Default_Ignorable_Code_Point}${String.fromCodePoint(0x2800)}]`,
  'u',
);
// Only the ASCII space separates words: every other space (no-break, ideographic, thin, …) can pass for one and for a
// differently-spelled twin of the same label.
const NON_ASCII_SPACE = /\p{Zs}/u;
const COMBINING_RUN = /\p{M}{4,}/u;
/** A single grapheme cluster built from more than this many code points is refused (a 50-jamo Hangul run is ONE grapheme). */
const MAX_CODE_POINTS_PER_GRAPHEME = 4;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// A marker a list could draw, which a model could use to impersonate the host's own numbers and ticks.
const LIST_MARKER_PREFIX =
  /^(?:[0-9]{1,2}[.)](?:\s|$)|\[[ xX*✓✔]?\]|\([ xX*•]?\)|[-*•·▪‣◦>](?:\s|$))/u;
// The host's own drawing, refused ANYWHERE in model text — not only at the start: a question is hard-wrapped, so a forged
// row can begin at any byte. The cursor, the own-answer glyph, the field's block cursor, the box-drawing range the rules
// are made of, the exact tick shapes of a row, and the approval card's single-key tokens.
const HOST_GLYPH = /[›✎█─-╿]/u;
const HOST_TICK_SHAPE = /\((?:•| )\)|\[(?:[xX]| )\]/u;
const APPROVAL_KEY_TOKEN = /\[[yYaAnNcCvV]\]/u;

/** True when some grapheme cluster of `value` is built from more than {@link MAX_CODE_POINTS_PER_GRAPHEME} code points. */
function hasOversizedGrapheme(value: string): boolean {
  for (const { segment } of GRAPHEMES.segment(value))
    if ([...segment].length > MAX_CODE_POINTS_PER_GRAPHEME) return true;
  return false;
}

/** The reason a model-authored string is refused, or `undefined` when it can be shown exactly as written. */
export function plainTextRefusal(value: string, maxBytes: number): string | undefined {
  // UTF-16 length is a cheap lower bound; only a plausible string reaches the byte measurement.
  if (value.length === 0 || value.trim().length === 0) return 'must not be empty';
  if (value.length > maxBytes || utf8ByteLength(value) > maxBytes)
    return `must contain at most ${maxBytes} UTF-8 bytes`;
  if (FORBIDDEN_CODE_POINT.test(value))
    return 'must be plain text without control or format characters';
  if (INVISIBLE_LETTER.test(value.replace(EMOJI_PRESENTATION, '')))
    return 'must not contain invisible characters';
  if (NON_ASCII_SPACE.test(value.replaceAll(' ', '')))
    return 'must separate words with an ordinary space only';
  if (COMBINING_RUN.test(value)) return 'must not stack more than three combining marks';
  if (hasOversizedGrapheme(value)) return 'must not build one character from many code points';
  if (value.normalize('NFC') !== value) return 'must be NFC-normalised';
  if (value !== value.trim()) return 'must not start or end with whitespace';
  if (LIST_MARKER_PREFIX.test(value)) return 'must not start with a list marker';
  if (HOST_GLYPH.test(value) || HOST_TICK_SHAPE.test(value) || APPROVAL_KEY_TOKEN.test(value))
    return "must not draw the host's own glyphs, tick shapes or approval keys";
  return undefined;
}

function plainText(maxBytes: number): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.string().superRefine((value, ctx) => {
    const refusal = plainTextRefusal(value, maxBytes);
    if (refusal !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: refusal });
  });
}

/** The comparison key for label uniqueness and reservation: NFC, trimmed, locale-independently case-folded. */
export function foldLabel(label: string): string {
  return label.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

const ReservedLabel = (label: string): boolean => {
  const folded = foldLabel(label);
  return (
    folded === 'other' ||
    folded.includes('type your own') ||
    label.startsWith(ASK_USER_OWN_ANSWER_GLYPH)
  );
};

const OptionSchema = z
  .object({
    label: plainText(ASK_USER_BOUNDS.labelBytes),
    description: plainText(ASK_USER_BOUNDS.descriptionBytes),
  })
  .strict();

const QuestionSchema = z
  .object({
    header: plainText(ASK_USER_BOUNDS.headerBytes),
    question: plainText(ASK_USER_BOUNDS.questionBytes),
    multiSelect: z.boolean().default(false),
    options: z.array(OptionSchema).min(2).max(ASK_USER_BOUNDS.optionsPerQuestion),
  })
  .strict()
  .superRefine((question, ctx) => {
    const seen = new Set<string>();
    for (const [index, option] of question.options.entries()) {
      if (ReservedLabel(option.label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'label'],
          message: 'is reserved for the host row',
        });
      }
      const key = foldLabel(option.label);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'label'],
          message: 'must be unique within the question',
        });
      }
      seen.add(key);
    }
  });

export const AskUserArgsSchema = z
  .object({ questions: z.array(QuestionSchema).min(1).max(ASK_USER_BOUNDS.questionsPerCall) })
  .strict();

/** The validated arguments — and the request the host receives, so a host never sees an unvalidated one. */
export type AskUserRequest = z.output<typeof AskUserArgsSchema>;
export type AskUserQuestion = AskUserRequest['questions'][number];

/** The model-visible JSON Schema. `maxLength` is a necessary character bound, not the byte authority. */
export const ASK_USER_LLM_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: ASK_USER_BOUNDS.questionsPerCall,
      description:
        'One to four related questions, asked one after another. Each needs two to four options.',
      items: {
        type: 'object',
        description: 'One question: a short header, the question, and two to four options.',
        properties: {
          header: {
            type: 'string',
            maxLength: ASK_USER_BOUNDS.headerBytes,
            description: `A short title for the question, at most ${ASK_USER_BOUNDS.headerBytes} UTF-8 bytes.`,
          },
          question: {
            type: 'string',
            maxLength: ASK_USER_BOUNDS.questionBytes,
            description: `The question, at most ${ASK_USER_BOUNDS.questionBytes} UTF-8 bytes, plain text on one line.`,
          },
          multiSelect: {
            type: 'boolean',
            description: 'True when the user may choose more than one option. Defaults to false.',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: ASK_USER_BOUNDS.optionsPerQuestion,
            description:
              'Two to four real alternatives. Do not add an "Other" option; the user can always type their own answer.',
            items: {
              type: 'object',
              description:
                'One alternative the user can choose, with a label and a short description.',
              properties: {
                label: {
                  type: 'string',
                  maxLength: ASK_USER_BOUNDS.labelBytes,
                  description: `The choice, at most ${ASK_USER_BOUNDS.labelBytes} UTF-8 bytes, unique within the question.`,
                },
                description: {
                  type: 'string',
                  maxLength: ASK_USER_BOUNDS.descriptionBytes,
                  description: `What choosing it means, at most ${ASK_USER_BOUNDS.descriptionBytes} UTF-8 bytes.`,
                },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['header', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

/** The model-facing description (ADR-0132 §6; pinned by a test). */
export const ASK_USER_DESCRIPTION =
  'Ask the user a question only they can answer: a choice between real alternatives, a preference, or a ' +
  'requirement you cannot find by reading files. Give two to four options with a short description each; do not ' +
  'add an "Other" option, because the user can always type their own answer. Ask up to four related questions in one ' +
  `call. Keep each question to at most ${ASK_USER_BOUNDS.questionBytes} bytes, labels to ${ASK_USER_BOUNDS.labelBytes}, ` +
  `descriptions to ${ASK_USER_BOUNDS.descriptionBytes} and headers to ${ASK_USER_BOUNDS.headerBytes}, in plain text ` +
  'with no control characters. Do not start any of them with a list marker such as `1.`, `-`, `>` or `[x]`, and do not ' +
  'use box-drawing or tick glyphs, `[y]`-style key tokens, zero-width or invisible characters, leading or trailing ' +
  'spaces, or non-NFC text. Never ask for a password, token or other secret. Do not use this to ask permission: ' +
  'approval of writes and commands is requested by the system, and an answer here changes no permission. Your ' +
  'question and the answer are kept with the conversation, so later turns can refer back to them (a long answer ' +
  'may be shortened); still state any decision you rely on in your reply.';

/* ------------------------------------------------------------------------------------------------ *
 * The delegate contract and the per-turn state.
 * ------------------------------------------------------------------------------------------------ */

/** One question's answer: the chosen option labels and/or the person's own text. */
export interface AskUserQuestionAnswer {
  readonly selected: readonly string[];
  readonly other?: string;
}

/** What the host returns. It resolves with one of these, or rejects with an `AbortError` when the turn is stopped. */
export type AskUserAnswer =
  | { readonly kind: 'answered'; readonly answers: readonly AskUserQuestionAnswer[] }
  | { readonly kind: 'skipped' };

/**
 * The shape check on what a host returns. A host is code we do not control from this module (a desktop or editor surface is
 * another team's), and a stray `null`, a string where an array belongs or a non-promise would otherwise surface as a raw
 * `TypeError` that the registry wraps as RECOVERABLE and RETRYABLE — which on a chat surface hands the model a failure it may
 * answer by reopening the card. Used only as a validator: the typed answer the host returned is what is read afterwards.
 */
export const AskUserAnswerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answered'),
      answers: z.array(
        z.object({ selected: z.array(z.string()), other: z.string().optional() }).strict(),
      ),
    })
    .strict(),
  z.object({ kind: z.literal('skipped') }).strict(),
]);

/**
 * The host's question delegate (`SessionDeps.askUser`). It resolves, or rejects with an `AbortError`; any other
 * failure — a malformed answer included — is fatal and not retryable, because a retry would reopen the card.
 */
export type AskUserDelegate = (
  request: AskUserRequest,
  signal?: AbortSignalLike,
) => Promise<AskUserAnswer>;

/**
 * The per-turn state the tool enforces "a skip closes questions" from (ADR-0132 §5). Built ONCE per session turn by the
 * session and carried by reference on the dispatch context, so every surface behaves alike and nothing is held in a module
 * (which would leak across sessions).
 *
 * There is deliberately NO count of cards per turn. A turn is already bounded by the engine (16 tool rounds, 16 calls per
 * response), a call carries up to four questions, and the person holds an instant, turn-wide circuit breaker: a skip closes
 * every further question this turn. A fixed ceiling would only stop a task that genuinely needs more answers.
 */
export interface AskUserTurnState {
  /** The person skipped a question this turn: no further card is shown. */
  skipped: boolean;
}

export function newAskUserTurnState(): AskUserTurnState {
  return { skipped: false };
}

/* ------------------------------------------------------------------------------------------------ *
 * Results and their fixed texts. Every one is a SUCCESSFUL, non-error result (recorded `ok`).
 * ------------------------------------------------------------------------------------------------ */

export const ASK_USER_SKIPPED_TEXT =
  'The user chose to skip this question. Continue with your best judgment, or ask in your reply. Do not ask again this turn.';
export const ASK_USER_SKIPPED_EARLIER_TEXT =
  'The user already skipped a question in this turn, so no question was shown. Continue with your best judgment, or ask in your reply.';

export type AskUserResult =
  | {
      readonly status: 'answered';
      readonly answers: readonly {
        readonly header: string;
        readonly selected: readonly string[];
        readonly other?: string;
      }[];
    }
  | { readonly status: 'skipped'; readonly message: string }
  | {
      readonly status: 'not_asked';
      readonly reason: 'skipped_earlier';
      readonly message: string;
    };

export function notAskedResult(reason: 'skipped_earlier'): AskUserResult {
  return { status: 'not_asked', reason, message: ASK_USER_SKIPPED_EARLIER_TEXT };
}

export function skippedResult(): AskUserResult {
  return { status: 'skipped', message: ASK_USER_SKIPPED_TEXT };
}

const AskUserResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('answered'),
      answers: z.array(
        z
          .object({
            header: z.string(),
            selected: z.array(z.string()),
            other: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ status: z.literal('skipped'), message: z.string() }).strict(),
  z
    .object({
      status: z.literal('not_asked'),
      reason: z.literal('skipped_earlier'),
      message: z.string(),
    })
    .strict(),
]);

/**
 * The content-free `agent:tool_result.outputSummary` (ADR-0132 §6), for the registry, which holds the result as `unknown`. Total: anything that is not this
 * tool's own result gets a fixed phrase, so the hook can never throw or echo what it was given.
 */
export function askUserDisplaySummaryOf(result: unknown): string {
  const parsed = AskUserResultSchema.safeParse(result);
  if (!parsed.success) return 'completed';
  switch (parsed.data.status) {
    case 'answered': {
      const count = parsed.data.answers.length;
      return count === 1 ? 'answered 1 question' : `answered ${String(count)} questions`;
    }
    case 'skipped':
      return 'skipped';
    case 'not_asked':
      return 'not asked';
    default: {
      const never: never = parsed.data;
      return never;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Answer validation — a malformed answer is a HOST fault, never the model's problem.
 * ------------------------------------------------------------------------------------------------ */

/** A malformed answer from the host. The caller classifies it fatal and not retryable. */
export class AskUserAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskUserAnswerError';
  }
}

const OWN_TEXT_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Check the host's answer against the request and build the model-facing result. The person's own text is masked of
 * secret-shaped runs here, in the engine, so every surface gets the same backstop (ADR-0132 §3); it is one line of at
 * most {@link ASK_USER_BOUNDS.ownTextCodePoints} code points and carries no control character.
 */
export function buildAnsweredResult(
  request: AskUserRequest,
  answer: Extract<AskUserAnswer, { kind: 'answered' }>,
): AskUserResult {
  if (answer.answers.length !== request.questions.length)
    throw new AskUserAnswerError('the answer does not match the number of questions');
  const answers = request.questions.map((question, index) => {
    const given = answer.answers[index];
    if (given === undefined) throw new AskUserAnswerError('a question has no answer');
    const labels = new Set(question.options.map((option) => option.label));
    const seen = new Set<string>();
    for (const label of given.selected) {
      if (!labels.has(label))
        throw new AskUserAnswerError('an answer names an option that is not offered');
      if (seen.has(label)) throw new AskUserAnswerError('an answer names an option twice');
      seen.add(label);
    }
    let other: string | undefined;
    if (given.other !== undefined) {
      if (OWN_TEXT_FORBIDDEN.test(given.other))
        throw new AskUserAnswerError(
          "the person's own text must be one line without control characters",
        );
      if ([...given.other].length > ASK_USER_BOUNDS.ownTextCodePoints)
        throw new AskUserAnswerError("the person's own text is over its limit");
      if (given.other.trim().length === 0)
        throw new AskUserAnswerError("the person's own text is empty");
      other = redactSecretShapedText(given.other.trim());
    }
    const chosen = given.selected.length + (other === undefined ? 0 : 1);
    if (question.multiSelect ? chosen < 1 : chosen !== 1)
      throw new AskUserAnswerError(
        question.multiSelect
          ? 'a multi-select question needs at least one choice or text'
          : 'a single-select question needs exactly one choice or text',
      );
    return {
      header: question.header,
      selected: [...given.selected],
      ...(other === undefined ? {} : { other }),
    };
  });
  return { status: 'answered', answers };
}

/* ------------------------------------------------------------------------------------------------ *
 * The durable record (ADR-0133) — what the person was asked and what they answered, kept with the session.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The question record a call leaves in the session, or `undefined` when no card was shown (`not_asked`) or the call is not
 * this tool's. Built from the VALIDATED request and the model-facing result — never from the host's raw answer — so the
 * person's text is the masked text the model itself received, and every chosen label is one the question offered, listed in
 * the order the card offered them. Total: it never throws, and a record that does not satisfy the shared schema is dropped
 * rather than stored (the call's result is unaffected either way).
 */
export function askUserRecord(
  request: AskUserRequest,
  result: unknown,
): SessionAskRecord | undefined {
  try {
    const parsed = AskUserResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.status === 'not_asked') return undefined;
    if (parsed.data.status === 'skipped')
      return SessionAskRecordSchema.parse({
        status: 'skipped',
        items: request.questions.map(({ header, question }) => ({ header, question })),
      });
    const { answers } = parsed.data;
    if (answers.length !== request.questions.length) return undefined;
    return SessionAskRecordSchema.parse({
      status: 'answered',
      items: request.questions.map(({ header, question, options }, index) => {
        const given = answers[index];
        const chosen = new Set(given?.selected);
        const selected = options.map((option) => option.label).filter((label) => chosen.has(label));
        // Masking can lengthen a run (`[redacted]` is ten characters), so the text is clipped to the stored ceiling.
        const other =
          given?.other === undefined
            ? undefined
            : [...given.other].slice(0, ASK_USER_BOUNDS.ownTextCodePoints).join('');
        return {
          header,
          question,
          selected,
          ...(other === undefined || other.length === 0 ? {} : { other }),
        };
      }),
    });
  } catch {
    return undefined;
  }
}
