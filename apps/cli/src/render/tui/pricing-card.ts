import {
  PRICING_FIELDS,
  modelIdFault,
  priceTextIssue,
  pricingField,
  type ModelIdFault,
  type PricingField,
  type PricingFieldId,
} from '../../commands/pricing-fields.js';
import { framedFlow, type FramedChordFlow } from '../../home/framed-flow.js';
import { sanitizeUntrustedInline } from '../sanitize.js';
import { flowText } from './flow-text.js';
import {
  NATIVE_PROMPT_BACK,
  type NativeChordPort,
  type NativePromptFlow,
} from './native-prompt-channel.js';
import { clipLine } from './sheet-frame.js';

/**
 * The pricing form of the Home — `/pricing`, the palette's name for `relavium models pricing`
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §9, MVP-8 step 5),
 * drawn as a popup ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6)
 * whose rail is `Action · Model · Rates · Confirm · Done` (every price prompt sits on `Rates`; a clear passes it by). It is a MONEY-FLOOR
 * write: a price stored here outranks the catalog's for every later run and chat on this machine, so the form is built to be unable to
 * record anything the person did not see.
 *
 * - **Its fields are the shell's.** After the first choice (`Set a price` or `Clear the override`) and the model, there is one prompt per
 *   row of the field table the shell's parser and core read (`commands/pricing-fields.ts`): a test walks that table, so the form cannot
 *   offer less than `relavium models pricing`, and a price added to the table is asked here without anyone remembering to. An empty
 *   answer means "not set". Each prompt refuses what the shell refuses (the same bounds, the same ceilings), in the field's label.
 * - **The card shows exactly what will be recorded.** It is built from a PREPARED plan (`preparePricing` in `commands/models-pricing.ts`:
 *   the model, the provider, the prices and the catalog price they replace; nothing written), in the units the table says, and the
 *   store's integer micro-cents are what it prints. Only `Ctrl+Y`, accepted by the chord guard, runs the commit, and it runs it once.
 * - **The default is No.** `Ctrl+N`, `Esc`, `Ctrl+C`, a flow cancelled under the card, a closed Home and every key that is not a chord
 *   all write nothing: only an `allow` the channel returned is a Yes. The card says that the override belongs to this machine's operator.
 * - **A refusal is a sentence, never a crash.** The pairing rule (input and output are set together, or not at all) and every other
 *   refusal of the core comes back as text in the card's place, with a way to change the prices or to close it; nothing is written. A
 *   write the database refuses is a fixed sentence.
 * - **The result is the Done step** (§6): what was recorded (or removed) and the rates, closed by `Enter` or `Esc`; a write the database
 *   refused says so there. Nothing goes to the Home's notice: leaving with nothing written is one notification, the sentence
 *   {@link runPricingCard} resolves with.
 *
 * **Every string a model, a provider or the core supplied passes the full scrub ({@link flowText}) before it reaches the channel**, and a
 * model id that the scrub would change is refused before the card asks (the card shows the id that is stored, or none); the bounds here
 * keep the popup inside 80×24.
 */

/**
 * One model the picker offers: what is recorded under (`modelId`, `provider`), and the hint that tells the person what it costs now (display
 * text the port composed from a known provider's display name and its own words; its ` · ` is the product's).
 */
export interface PricingModelChoice {
  readonly modelId: string;
  readonly provider: string;
  readonly hint: string;
}

/** What a price is for: one model under one provider (a price is keyed by both). */
export interface PricingTarget {
  readonly modelId: string;
  readonly provider: string;
}

/** What the person asked for: a SET with the text of each price they gave (an absent field is not set), or a CLEAR. */
export type PricingValues =
  | { readonly action: 'clear' }
  | {
      readonly action: 'set';
      readonly prices: Readonly<Partial<Record<PricingFieldId, string>>>;
    };

/** One price the card shows: the field, the amount in the field's unit, and the integer micro-cents the store will hold. */
export interface PricingOfferPrice {
  readonly id: PricingFieldId;
  readonly label: string;
  /** `$3/Mtok`, `$0.04/image`: the amount from the stored integer, in the unit the field table says. */
  readonly amount: string;
  readonly microcents: number;
}

/** What the card says about a prepared plan: all of it display text and the numbers it was made from, nothing a write is built from. */
export interface PricingOffer {
  readonly kind: 'set' | 'clear';
  readonly model: string;
  readonly provider: string;
  /** What a person reads for `provider` (`OpenAI`, not `openai`); absent ⇒ the id itself. The id is what the write is keyed by. */
  readonly providerName?: string;
  /** The prices a SET will record, in the field table's order; empty for a CLEAR. */
  readonly prices: readonly PricingOfferPrice[];
  /** Whether a SET leaves a field alone: a price not stated keeps what the row holds now. */
  readonly keeps: boolean;
  /** What the catalog charges for the prices this SET replaces (`input $5/Mtok, output $30/Mtok`), or none. */
  readonly replaces: string | undefined;
  /** What a CLEAR falls back to (`input $5/Mtok, output $30/Mtok`), or none when the catalog does not price the model. */
  readonly fallback: string | undefined;
}

/** What a commit left: the sentence the Home shows, or the reason it did not write. */
export type PricingAttempt =
  | { readonly ok: true; readonly written: string }
  | { readonly ok: false; readonly reason: string };

/** A prepared plan, or the reason there is none: `commit` writes exactly what the offer describes. */
export type PricingPrepared =
  | { readonly ok: true; readonly offer: PricingOffer; readonly commit: () => PricingAttempt }
  | { readonly ok: false; readonly reason: string };

/** The Home's pricing seam: prepare writes nothing, and a refusal comes back as text, not as a throw. */
export interface PricingPort {
  /** The models the picker offers: the catalog the `/models` picker lists. Read when the form opens. */
  readonly models: () => readonly PricingModelChoice[];
  /** The registered providers' slugs, for a model id the catalog does not list. */
  readonly providers: () => readonly string[];
  /** What a person reads for a provider's slug (`OpenAI`, not `openai`); absent ⇒ the slug itself. */
  readonly providerName?: (slug: string) => string;
  readonly prepare: (target: PricingTarget, values: PricingValues) => PricingPrepared;
}

export const PRICING_ACTION_SET = 'Set a price';
export const PRICING_ACTION_CLEAR = 'Clear the override';
export const PRICING_OTHER_MODEL = 'Another model…';
export const PRICING_SET_ALLOW_LABEL = 'Record the price';
export const PRICING_CLEAR_ALLOW_LABEL = 'Remove the override';
export const PRICING_DENY_LABEL = 'Write nothing';
export const PRICING_CLOSE_LABEL = 'Close';
export const PRICING_EDIT_LABEL = 'Change the prices';
/** The notification when the card was answered with anything but a Yes, or the form was left. */
export const PRICING_NOT_RECORDED = 'Nothing was written.';
/** What the Done step says when the write itself was refused. */
export const PRICING_FAILED = 'Not recorded.';
export const PRICING_TITLE = '/pricing';
export const PRICING_STEPS = ['Action', 'Model', 'Rates', 'Confirm', 'Done'] as const;
/** The rail's step of each prompt of the form (the Done step is the rail's last). */
const RAIL = { action: 0, model: 1, rates: 2, confirm: 3 } as const;
/** The ownership sentence of a SET: the override is the operator's, on this machine, and it outranks the catalog. */
export const PRICING_SET_OWNERSHIP =
  "This override belongs to this machine's operator: it is stored here and outranks the catalog price for this model.";
/** The ownership sentence of a CLEAR: only the operator's own price goes, never the catalog's. */
export const PRICING_CLEAR_OWNERSHIP =
  "This override belongs to this machine's operator: removing it deletes only that price, never the catalog's.";

const MODEL_COLUMNS = 80;
const DETAIL_COLUMNS = 160;
const REASON_COLUMNS = 240;
const HINT_COLUMNS = 80;
/** The most code units of a model id the form takes, by hand or from a list. */
export const PRICING_MODEL_ID_LIMIT = 200;
const OTHER_VALUE = 'other';

const label = (name: string): string => name.padEnd(12);

export interface PricingCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** The card's words for one offer: the question, exactly what is recorded (or removed), and whose override it is. */
export function pricingCardText(offer: PricingOffer): PricingCardText {
  const model = clipLine(flowText(offer.model), MODEL_COLUMNS);
  const provider = flowText(offer.providerName ?? offer.provider);
  const target = `${model} (${provider})`;
  if (offer.kind === 'clear') {
    return {
      message: `Remove your price override for '${model}' under ${provider}?`,
      details: [
        `${label('model')}${target}`,
        offer.fallback === undefined
          ? 'The catalog does not price this model, so its cost cap will not apply until you price it again.'
          : `Afterwards it falls back to the catalog: ${offer.fallback}.`,
        PRICING_CLEAR_OWNERSHIP,
      ].map((line) => clipLine(line, DETAIL_COLUMNS)),
      allow: PRICING_CLEAR_ALLOW_LABEL,
      deny: PRICING_DENY_LABEL,
    };
  }
  return {
    message: `Record your price for '${model}' under ${provider}?`,
    details: [
      `${label('model')}${target}`,
      ...offer.prices.map((price) => `${label(price.id)}${price.amount}`),
      ...(offer.keeps ? ['A price you left empty keeps what is stored now.'] : []),
      ...(offer.replaces === undefined ? [] : [`Replaces the catalog price: ${offer.replaces}.`]),
      PRICING_SET_OWNERSHIP,
    ].map((line) => clipLine(line, DETAIL_COLUMNS)),
    allow: PRICING_SET_ALLOW_LABEL,
    deny: PRICING_DENY_LABEL,
  };
}

/** What the refusal step says above the reason (the prepare's own sentence, which says why): a set and a clear alike changed nothing. */
export const PRICING_REFUSED = 'Nothing was changed.';

/** What the Done step says for a write that was made: what was recorded (or removed) and the rates, and the core's own sentence under it. */
export function pricingDoneText(
  offer: PricingOffer,
  written: string,
): { readonly message: string; readonly lines: readonly string[] } {
  const model = clipLine(flowText(offer.model), MODEL_COLUMNS);
  const rates = offer.prices.map((price) => `${price.id} ${price.amount}`).join(', ');
  return {
    message:
      offer.kind === 'clear'
        ? `Removed · ${model}`
        : `Recorded · ${model}${rates === '' ? '' : ` · ${rates}`}`,
    lines: [clipLine(flowText(written), REASON_COLUMNS)],
  };
}

/** The prompt for one field, generated from its row of the field table. */
export function pricingFieldMessage(field: PricingField, model: string): string {
  const mate = field.pairedWith === undefined ? undefined : pricingField(field.pairedWith);
  const together =
    mate === undefined
      ? ''
      : ` Set together with the ${mate.label.toLowerCase()}, or leave both empty.`;
  return `${field.label} for '${clipLine(flowText(model), MODEL_COLUMNS)}', ${field.unitWords}. Empty: not set.${together}`;
}

/** Why the card cannot state a model id as it is stored. */
export type PricingModelIdFault = ModelIdFault | 'too-long' | 'unsafe';

/**
 * Whether the card can show `id` exactly as it would be stored, or why it cannot. The card says which model it records, so an id it
 * cannot say faithfully is refused. The first three faults are the field table's rule ({@link modelIdFault}), which `relavium models
 * pricing` applies to a SET as well: the shell and the form cannot disagree about which ids are priced. The last two belong to a card.
 *
 * - `empty`, `invisible` and `padded`: nothing, a format or default-ignorable character, or a space at either end that hides inside
 *   the card's quotes (so `gpt-5` and `gpt-5 ` would read the same).
 * - `too-long`: more than {@link PRICING_MODEL_ID_LIMIT} code units, or more columns than the card gives the id
 *   ({@link MODEL_COLUMNS}). The card shows the id in full or not at all: it never cuts it short with an ellipsis.
 * - `unsafe`: the sanitizer or the popup's full scrub would change it (a control byte, a bidirectional override, a key-shaped string, a
 *   compatibility form, a host glyph, a chord or a legend token): the popup draws every id through that scrub ({@link flowText}), so an id it
 *   would draw otherwise than it is stored cannot be priced from here.
 */
export function pricingModelIdFault(id: string): PricingModelIdFault | undefined {
  const shared = modelIdFault(id);
  if (shared !== undefined) return shared;
  if (id.length > PRICING_MODEL_ID_LIMIT || clipLine(id, MODEL_COLUMNS) !== id) return 'too-long';
  if (sanitizeUntrustedInline(id) !== id || flowText(id) !== id) return 'unsafe';
  return undefined;
}

/** The fixed sentence for each fault: it never quotes the id (the id is the thing that cannot be shown). */
export const PRICING_MODEL_ID_FAULTS: Readonly<Record<PricingModelIdFault, string>> = {
  empty: 'Type a model id.',
  // `padded` and `invisible` are refused by the SHELL's core too (`modelIdFault`), so no command is named: there is none that prices them.
  padded:
    'This model id starts or ends with a space, so the card cannot show it as it is stored, and it cannot be priced.',
  invisible:
    'This model id has invisible or formatting characters, so it cannot be shown safely, and it cannot be priced.',
  'too-long': `This model id is longer than the ${String(MODEL_COLUMNS)} columns the card can show in full, so it cannot be priced from here. Use relavium models pricing.`,
  unsafe:
    'This model id has characters that cannot be shown safely, so it cannot be priced from here. Use relavium models pricing.',
};

/** What the form says about a model id typed by hand (spaces around it are dropped first), or none when it is acceptable. */
export function pricingModelIdIssue(value: string): string | undefined {
  const fault = pricingModelIdFault(value.trim());
  return fault === undefined ? undefined : PRICING_MODEL_ID_FAULTS[fault];
}

export interface PricingCardDeps {
  /** The Home's native prompt flow: framed here as the `/pricing` popup (its selects and text fields, its chord card, its Done step). */
  readonly flow: NativePromptFlow & NativeChordPort;
  readonly port: PricingPort;
  /** Throws when the Home is closing; called before anything is read or asked. */
  readonly assertAdmitting?: (() => void) | undefined;
}

interface Draft {
  action: 'set' | 'clear' | undefined;
  target: PricingTarget | undefined;
  readonly prices: Map<PricingFieldId, string>;
}

type StepResult = 'next' | 'back' | 'stop';

interface Step {
  readonly applies: (draft: Draft) => boolean;
  readonly run: (draft: Draft) => Promise<StepResult>;
}

/** An answer that is not text: `Esc` where it steps back one step, or anything else (`Ctrl+C`, a closed Home) which leaves the flow. */
const awayFrom = (answer: symbol): 'back' | 'stop' =>
  answer === NATIVE_PROMPT_BACK ? 'back' : 'stop';

/** The steps of the form, in order, each asked on its step of the rail. The per-field steps are one per row of the field table. */
function stepsOf(
  flow: FramedChordFlow,
  port: PricingPort,
  choices: readonly PricingModelChoice[],
): readonly Step[] {
  const action: Step = {
    applies: () => true,
    run: async (draft) => {
      const answer = await flow.at(RAIL.action).select({
        message: 'Model pricing: what do you want to do?',
        options: [
          { value: 'set', label: PRICING_ACTION_SET, hint: 'record your own price for a model' },
          {
            value: 'clear',
            label: PRICING_ACTION_CLEAR,
            hint: "remove your price; the catalog's applies again",
          },
        ],
        ...(draft.action === undefined ? {} : { initialValue: draft.action }),
        escape: 'cancel',
      });
      if (answer === 'set' || answer === 'clear') {
        draft.action = answer;
        return 'next';
      }
      return 'stop';
    },
  };

  /** A model id typed by hand, then the provider that serves it; `Esc` at the provider asks for the id again. */
  const askOther = async (): Promise<PricingTarget | 'back' | 'stop'> => {
    const on = flow.at(RAIL.model);
    for (;;) {
      const id = await on.text({
        message: 'Model id',
        validate: pricingModelIdIssue,
        escape: 'back',
      });
      if (typeof id !== 'string') return awayFrom(id);
      const slugs = port.providers();
      if (slugs.length === 0) {
        flow.note('No provider is registered yet. Connect one with /providers.', 'Price');
        return 'back';
      }
      const provider = await on.select({
        message: `Which provider serves '${clipLine(flowText(id.trim()), MODEL_COLUMNS)}'?`,
        options: slugs.map((slug) => ({
          value: slug,
          label: flowText(port.providerName?.(slug) ?? slug),
        })),
        escape: 'back',
      });
      if (typeof provider !== 'string') {
        if (provider === NATIVE_PROMPT_BACK) continue;
        return 'stop';
      }
      return { modelId: id.trim(), provider };
    }
  };

  const model: Step = {
    applies: () => true,
    run: async (draft) => {
      for (;;) {
        const answer = await flow.at(RAIL.model).select({
          message: 'Which model?',
          options: [
            ...choices.map((choice, index) => ({
              value: String(index),
              label: clipLine(flowText(choice.modelId), MODEL_COLUMNS),
              // the port's display text: a known provider's display name and the port's own words, its separator the product's own
              hint: clipLine(choice.hint, HINT_COLUMNS),
            })),
            {
              value: OTHER_VALUE,
              label: PRICING_OTHER_MODEL,
              hint: 'a model id the list does not show',
            },
          ],
          escape: 'back',
        });
        if (typeof answer !== 'string') return awayFrom(answer);
        if (answer === OTHER_VALUE) {
          const typed = await askOther();
          if (typed === 'back') continue;
          if (typed === 'stop') return 'stop';
          draft.target = typed;
          return 'next';
        }
        const choice = choices[Number(answer)];
        if (choice === undefined) return 'stop';
        draft.target = { modelId: choice.modelId, provider: choice.provider };
        return 'next';
      }
    },
  };

  const fields: readonly Step[] = PRICING_FIELDS.map(
    (field): Step => ({
      applies: (draft) => draft.action === 'set',
      run: async (draft) => {
        const answer = await flow.at(RAIL.rates).text({
          message: pricingFieldMessage(field, draft.target?.modelId ?? ''),
          validate: (value) => priceTextIssue(field, value),
          escape: 'back',
        });
        if (typeof answer !== 'string') return awayFrom(answer);
        const text = answer.trim();
        if (text === '') draft.prices.delete(field.id);
        else draft.prices.set(field.id, text);
        return 'next';
      },
    }),
  );
  return [action, model, ...fields];
}

/** Walk the steps from `from`, forward on an answer and back on `Esc`; leaving the first step leaves the flow. */
async function walk(
  steps: readonly Step[],
  draft: Draft,
  from: number,
): Promise<'done' | 'stopped'> {
  let index = from;
  let direction: 1 | -1 = 1;
  while (index >= 0 && index < steps.length) {
    const step = steps[index];
    if (!step?.applies(draft)) {
      index += direction;
      continue;
    }
    const result = await step.run(draft);
    if (result === 'stop') return 'stopped';
    direction = result === 'back' ? -1 : 1;
    index += direction;
  }
  return index < 0 ? 'stopped' : 'done';
}

/**
 * The refusal where the card would have been, on the rail's Confirm step: the reason, and the ways out. Resolves `true` when the person wants
 * to change the prices. Whatever closes it writes nothing.
 */
async function showRefusal(
  flow: FramedChordFlow,
  reason: string,
  canEdit: boolean,
): Promise<boolean> {
  const answer = await flow.at(RAIL.confirm).select({
    message: PRICING_REFUSED,
    details: [clipLine(flowText(reason), REASON_COLUMNS)],
    options: [
      ...(canEdit ? [{ value: 'edit', label: PRICING_EDIT_LABEL }] : []),
      { value: 'close', label: PRICING_CLOSE_LABEL },
    ],
    escape: 'cancel',
  });
  return answer === 'edit';
}

/** What the person asked for, as the port takes it: a CLEAR, or a SET with the text of each price they gave. */
function valuesOf(action: 'set' | 'clear', draft: Draft): PricingValues {
  return action === 'clear'
    ? { action: 'clear' }
    : { action: 'set', prices: Object.fromEntries(draft.prices) };
}

/**
 * Show the card of a prepared plan and write it only on a Yes, then end in the Done step. The default is No: only an `allow` the chord
 * guard let through is a Yes, never "anything that is not a `deny`". Resolves with the notification for a No, else `undefined`.
 */
async function confirmAndCommit(
  flow: FramedChordFlow,
  prepared: Extract<PricingPrepared, { readonly ok: true }>,
  signal: AbortSignal,
): Promise<string | undefined> {
  const text = pricingCardText(prepared.offer);
  const answer = await flow.at(RAIL.confirm).chord({ ...text, escape: 'cancel', signal });
  if (answer !== 'allow') return PRICING_NOT_RECORDED;
  const attempt = prepared.commit();
  if (attempt.ok) await flow.done(pricingDoneText(prepared.offer, attempt.written));
  else
    await flow.done({
      message: PRICING_FAILED,
      lines: [clipLine(flowText(attempt.reason), REASON_COLUMNS)],
      label: PRICING_CLOSE_LABEL,
      tone: 'failed',
    });
  return undefined;
}

/**
 * Walk the steps, prepare what was asked, and either confirm it or, on a refusal, offer to change the prices (back to the first
 * price's step) until the person writes, declines or leaves.
 */
async function askAndWrite(
  flow: FramedChordFlow,
  port: PricingPort,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const draft: Draft = { action: undefined, target: undefined, prices: new Map() };
  // The first field's step: where a person who is refused returns to change the prices.
  const firstField = steps.length - PRICING_FIELDS.length;
  let from = 0;
  for (;;) {
    if ((await walk(steps, draft, from)) === 'stopped') return PRICING_NOT_RECORDED;
    const { action, target } = draft;
    if (action === undefined || target === undefined) return PRICING_NOT_RECORDED;
    const prepared = port.prepare(target, valuesOf(action, draft));
    if (prepared.ok) return confirmAndCommit(flow, prepared, signal);
    // The refusal was read where it was shown: closing it leaves nothing more to say.
    if (!(await showRefusal(flow, prepared.reason, action === 'set'))) return undefined;
    from = firstField;
  }
}

/**
 * Ask what to price, prepare the plan, show it, and write it only on a Yes. Resolves with the ONE notification the Home shows (nothing was
 * written: a No, an `Esc`, a cancel), or `undefined` when the popup itself said what happened (the Done step, a refusal). The flow is begun
 * here and ended here, whatever the answer.
 */
export async function runPricingCard(deps: PricingCardDeps): Promise<string | undefined> {
  deps.assertAdmitting?.();
  const choices = deps.port.models();
  const flow = framedFlow(deps.flow, {
    title: PRICING_TITLE,
    origin: 'home',
    stepNames: PRICING_STEPS,
    progress: 'manual',
  });
  const signal = flow.begin();
  try {
    return await askAndWrite(flow, deps.port, stepsOf(flow, deps.port, choices), signal);
  } finally {
    await flow.end();
  }
}
