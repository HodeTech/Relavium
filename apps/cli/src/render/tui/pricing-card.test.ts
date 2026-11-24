/**
 * The pricing form of the Home ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5): it asks one question per row of the field table, shows exactly what will be recorded before it writes, its default
 * is No, and only a `Ctrl+Y` the chord guard accepts writes, once, through the commit. `Esc`, `Ctrl+C`, `Ctrl+N`, a flow cancelled under
 * the card and every key that is not a chord write nothing; a refusal (the pairing rule included) is a sentence in the card's place.
 *
 * The prompt channel is the real one (keys go in through `ui.input`, as the host's `useInput` delivers them), and so is the port, over a
 * `:memory:` database and the real catalog store, so "writes nothing" is read from the database and not from a flag the card keeps. No
 * test touches an operator's `history.db`.
 */
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
  type ModelCatalogListing,
  type ModelCatalogStore,
} from '@relavium/db';
import type { ModelCatalogEntry } from '@relavium/llm';
import { randomUUID } from 'node:crypto';

import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRICING_FIELDS, type PricingFieldId } from '../../commands/pricing-fields.js';
import { PRICING_WRITE_FAULT, createPricingPort } from '../../home/pricing-port.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import {
  PRICING_ACTION_CLEAR,
  PRICING_ACTION_SET,
  PRICING_CLEAR_ALLOW_LABEL,
  PRICING_CLEAR_OWNERSHIP,
  PRICING_CLOSE_LABEL,
  PRICING_DENY_LABEL,
  PRICING_EDIT_LABEL,
  PRICING_MODEL_ID_FAULTS,
  PRICING_NOT_RECORDED,
  PRICING_OTHER_MODEL,
  PRICING_SET_ALLOW_LABEL,
  PRICING_SET_OWNERSHIP,
  pricingCardText,
  pricingFieldMessage,
  pricingModelIdIssue,
  runPricingCard,
  type PricingOffer,
  type PricingPort,
  type PricingPrepared,
} from './pricing-card.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

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
const ctrl: Key = { ...none, ctrl: true };
const enter: Key = { ...none, return: true };

/**
 * The ceilings as the product states them (ADR-0089 section 4, the models-pricing docs), written out here and NOT read from the table: a
 * test that read its limit from the table would follow a table that was changed by mistake. The field-table test pins the table to these.
 */
const CEILING: Readonly<Record<PricingFieldId, number>> = {
  input: 100_000,
  output: 100_000,
  cached: 100_000,
  image: 1_000,
  audio: 1_000,
  video: 1_000,
};

const entry = (modelId: string, over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  modelId,
  provider: 'openai',
  displayName: modelId,
  pricingSource: 'none',
  priceKnown: false,
  available: true,
  deprecated: false,
  ...over,
});

let client: DbClient;
let catalog: ModelCatalogStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

const rowsFor = (modelId: string): ModelCatalogListing[] =>
  catalog.listAll().filter((row) => row.modelId === modelId);

/** The real port over the in-memory database, with every prepare and every commit recorded. */
function countingPort(entries: readonly ModelCatalogEntry[]) {
  let n = 0;
  const storeDeps = {
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => 1_700_000_000_000,
  };
  createProviderStore(client.db, storeDeps).upsert({
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });
  createProviderStore(client.db, storeDeps).upsert({
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
  });
  catalog = createModelCatalogStore(client.db, storeDeps);
  const base = createPricingPort({ db: client.db, ...storeDeps, models: () => entries });
  const commits = vi.fn();
  const offers: PricingOffer[] = [];
  const port: PricingPort = {
    ...base,
    prepare: (target, values): PricingPrepared => {
      const prepared = base.prepare(target, values);
      if (!prepared.ok) return prepared;
      offers.push(prepared.offer);
      return {
        ...prepared,
        commit: () => {
          commits();
          return prepared.commit();
        },
      };
    },
  };
  return { port, commits, offers };
}

/** The real channel with a clock the test moves, the form running, and the helpers that answer it as the host would. */
function rig(
  entries: readonly ModelCatalogEntry[] = [
    entry('gpt-5.5', { pricingSource: 'catalog' }),
    entry('acme-custom-1'),
  ],
) {
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const counted = countingPort(entries);
  const result = runPricingCard({ flow: channel.flow, port: counted.port });
  const snap = () => channel.ui.getSnapshot();

  /** Wait for a prompt of `kind` whose message contains `text`. */
  const until = (kind: 'select' | 'text' | 'chord', text?: string) =>
    vi.waitFor(
      () => {
        expect(snap().kind).toBe(kind);
        if (text !== undefined) expect(snap().message).toContain(text);
      },
      { timeout: WAIT_MS, interval: 5 },
    );
  /** Pick the option labelled `labelText` in the open select, with the arrows, then Enter. */
  const choose = (labelText: string): void => {
    const { options, selected } = snap();
    const target = options.findIndex((option) => option.label === labelText);
    if (target < 0)
      throw new Error(`no option "${labelText}" in ${options.map((o) => o.label).join(' | ')}`);
    for (let at = selected; at !== target; at = (at + 1) % options.length)
      channel.ui.input('', { ...none, downArrow: true });
    channel.ui.input('', enter);
  };
  const type = (text: string): void => {
    if (text !== '') channel.ui.paste(text);
    channel.ui.input('', enter);
  };
  const escape = (): void => {
    channel.ui.input('', { ...none, escape: true });
  };
  /** The card is up: let it be painted and read, long enough that the guard accepts a chord. */
  const cardUp = async (): Promise<void> => {
    await until('chord');
    now = 0;
    channel.ui.shown(snap());
    now = 10_000;
  };
  /** Answer the first two questions: the action, then the model by its id. */
  const start = async (action: string, model: string): Promise<void> => {
    await until('select', 'what do you want to do');
    choose(action);
    await until('select', 'Which model');
    choose(model);
  };
  /** Answer every field prompt, in the table's order, asserting that each row of the table is asked. */
  const fill = async (values: Partial<Record<PricingFieldId, string>>): Promise<void> => {
    for (const field of PRICING_FIELDS) {
      await until('text', field.label);
      type(values[field.id] ?? '');
    }
  };
  return {
    ...channel,
    ...counted,
    result,
    snap,
    until,
    choose,
    type,
    escape,
    cardUp,
    start,
    fill,
    at: (ms: number) => (now = ms),
  };
}

type Rig = ReturnType<typeof rig>;

/** A form that has asked everything and is showing the card for a token pair on a custom model. */
async function atCard(r: Rig): Promise<void> {
  await r.start(PRICING_ACTION_SET, 'acme-custom-1');
  await r.fill({ input: '3', output: '9' });
  await r.cardUp();
}

describe('the form asks one question per row of the field table', () => {
  it("opens on the choice, then the model, then every field in the table's order, each in its unit", async () => {
    const r = rig();
    await r.until('select', 'what do you want to do');
    expect(r.snap().options.map((option) => option.label)).toEqual([
      PRICING_ACTION_SET,
      PRICING_ACTION_CLEAR,
    ]);
    r.choose(PRICING_ACTION_SET);
    await r.until('select', 'Which model');
    expect(r.snap().options.map((option) => option.label)).toEqual([
      'gpt-5.5',
      'acme-custom-1',
      PRICING_OTHER_MODEL,
    ]);
    expect(r.snap().options.map((option) => option.hint)).toEqual([
      'openai · catalog price',
      'openai · no price',
      'a model id the list does not show',
    ]);
    r.choose('acme-custom-1');

    for (const field of PRICING_FIELDS) {
      await r.until('text', field.label);
      const message = r.snap().message;
      expect(message, field.id).toBe(pricingFieldMessage(field, 'acme-custom-1'));
      expect(message, `${field.id} is quoted in its unit`).toContain(field.unitWords);
      expect(message).toContain("'acme-custom-1'");
      expect(message).toContain('Empty: not set.');
      r.type('');
    }
    // Nothing was given, so the core refuses: at least one price is needed. It is a sentence in the card's place.
    await r.until('select', 'Not recorded.');
    expect(r.snap().message).toContain('Set at least one price');
    r.choose(PRICING_CLOSE_LABEL);
    expect(await r.result).toMatch(/^Not recorded\. Set at least one price/u);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('asks the pair together: the input names the output, and the output names the input', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.until('text', 'Input price');
    expect(r.snap().message).toContain('Set together with the output price, or leave both empty.');
    r.type('3');
    await r.until('text', 'Output price');
    expect(r.snap().message).toContain('Set together with the input price, or leave both empty.');
    r.escape();
    r.flow.cancel();
    await r.result;
  });

  it('refuses in the prompt what the shell refuses: a ceiling, a negative, a text that is not a number', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    for (const field of PRICING_FIELDS) {
      await r.until('text', field.label);
      for (const [bad, expected] of [
        [
          String(CEILING[field.id] + 0.01),
          new RegExp(
            'implausibly large — the maximum is \\$' + String(CEILING[field.id]) + '(?![0-9])',
            'u',
          ),
        ],
        ['-1', /must be a finite, non-negative number/u],
        ['abc', /must be a finite number of/u],
        // A positive price below one micro-cent would be stored as the `0` that means "free"; one with more decimals than a micro-cent
        // has would be stored as another number than the one typed. Neither is recorded, and neither is rounded.
        ['0.000000004', /is below the smallest price that can be stored, \$0\.00000001 per /u],
        ['0.123456789', /has more than 8 decimal places/u],
      ] as const) {
        r.type(bad);
        await vi.waitFor(() => expect(r.snap().error, `${field.id} ${bad}`).toMatch(expected), {
          timeout: WAIT_MS,
          interval: 5,
        });
        expect(r.snap().kind, 'the prompt stays open').toBe('text');
        expect(r.snap().error).toContain(field.label);
        // Clear the line to ask again.
        for (let i = 0; i < bad.length; i += 1) r.ui.input('', { ...none, backspace: true });
      }
      r.type('');
    }
    await r.until('select', 'Not recorded.');
    r.choose(PRICING_CLOSE_LABEL);
    await r.result;
    expect(catalog.listAll()).toHaveLength(0);
  });
});

describe('the card shows exactly what will be recorded, and whose override it is', () => {
  it("names the model, every price in the table's unit, the catalog price it replaces and the operator's ownership", async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'gpt-5.5');
    await r.fill({
      input: '3',
      output: '9',
      cached: '0.03',
      image: '0.04',
      audio: '0.001',
      video: '0.5',
    });
    await r.cardUp();
    const card = r.snap();
    expect(card.kind).toBe('chord');
    expect(card.message).toBe("Record your price for 'gpt-5.5' under openai?");
    expect(card.details).toEqual([
      'model       gpt-5.5 (openai)',
      'input       $3/Mtok',
      'output      $9/Mtok',
      'cached      $0.03/Mtok',
      'image       $0.04/image',
      'audio       $0.001/s',
      'video       $0.5/s',
      'Replaces the catalog price: input $5/Mtok, output $30/Mtok, cached $0.5/Mtok.',
      PRICING_SET_OWNERSHIP,
    ]);
    expect(card.details.at(-1)).toContain("belongs to this machine's operator");
    expect(card.options.map((option) => option.label)).toEqual([
      PRICING_SET_ALLOW_LABEL,
      PRICING_DENY_LABEL,
    ]);
    expect(catalog.listAll(), 'asking writes nothing').toHaveLength(0);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
  });

  it("is built from the plan: the card's text is the offer's, and the row read back holds the offer's integers", async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.fill({ input: '0.12345679', output: '9', video: '0.5' });
    await r.cardUp();
    const offer = r.offers.at(-1);
    if (offer === undefined) throw new Error('no plan was prepared');
    expect(r.snap().details).toEqual(pricingCardText(offer).details);
    expect(r.snap().details).toContain('input       $0.12345679/Mtok');
    expect(
      r.snap().details.some((line) => /^(cached|image|audio)/u.test(line)),
      'a price that was left empty is not on the card',
    ).toBe(false);
    expect(r.snap().details).toContain('A price you left empty keeps what is stored now.');
    r.ui.input('y', ctrl);
    expect(await r.result).toContain(
      'Set user pricing for acme-custom-1 (openai): input $0.12345679/Mtok',
    );
    const [row] = rowsFor('acme-custom-1');
    const stored: Record<PricingFieldId, number | null | undefined> = {
      input: row?.inputCostPerMtokMicrocents,
      output: row?.outputCostPerMtokMicrocents,
      cached: row?.cachedInputCostPerMtokMicrocents,
      image: row?.mediaImageCostMicrocents,
      audio: row?.mediaAudioCostMicrocents,
      video: row?.mediaVideoCostMicrocents,
    };
    for (const price of offer.prices) expect(stored[price.id], price.id).toBe(price.microcents);
    expect(offer.prices.map((price) => price.id)).toEqual(['input', 'output', 'video']);
    // Nothing is stored that the card did not show: the cached rate was not stated, so it is not marked as stated.
    expect(row?.cachedInputStated).toBe(false);
    expect(row?.tokenRatesStated).toBe(true);
    expect(stored.image).toBeNull();
    expect(stored.audio).toBeNull();
  });

  it('keeps every line inside the card: a long model id is clipped, not allowed to push the card past the screen', () => {
    const text = pricingCardText({
      kind: 'set',
      model: 'm'.repeat(400),
      provider: 'openai',
      prices: [{ id: 'input', label: 'Input price', amount: '$3/Mtok', microcents: 300_000_000 }],
      keeps: true,
      replaces: `input $${'9'.repeat(400)}/Mtok`,
      fallback: undefined,
    });
    expect(text.message.length).toBeLessThan(140);
    for (const line of text.details) expect(line.length).toBeLessThanOrEqual(160);
    expect(text.details).toHaveLength(5);
  });

  it('a CLEAR says what the model falls back to, and whose override goes', async () => {
    const r = rig();
    // Seed an override through the same port, then clear it through the form.
    const seed = r.port.prepare(
      { modelId: 'gpt-5.5', provider: 'openai' },
      { action: 'set', prices: { input: '3', output: '9' } },
    );
    if (!seed.ok) throw new Error(seed.reason);
    seed.commit();
    r.commits.mockClear();
    await r.start(PRICING_ACTION_CLEAR, 'gpt-5.5');
    await r.cardUp();
    expect(r.snap().message).toBe("Remove your price override for 'gpt-5.5' under openai?");
    expect(r.snap().details).toEqual([
      'model       gpt-5.5 (openai)',
      'Afterwards it falls back to the catalog: input $5/Mtok, output $30/Mtok.',
      PRICING_CLEAR_OWNERSHIP,
    ]);
    expect(r.snap().options.map((option) => option.label)).toEqual([
      PRICING_CLEAR_ALLOW_LABEL,
      PRICING_DENY_LABEL,
    ]);
    expect(rowsFor('gpt-5.5'), 'asking removes nothing').toHaveLength(1);
    r.ui.input('y', ctrl);
    expect(await r.result).toBe(
      'Cleared the user price for gpt-5.5 (openai). It falls back to the catalog: input $5/Mtok, output $30/Mtok.',
    );
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(rowsFor('gpt-5.5')).toHaveLength(0);
  });

  it('a CLEAR of a model with no override says so and asks for nothing', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_CLEAR, 'gpt-5.5');
    await r.until('select', 'Not recorded.');
    expect(r.snap().message).toContain('has no user price to clear — nothing changed.');
    expect(
      r.snap().options.map((option) => option.label),
      'there is nothing to change',
    ).toEqual([PRICING_CLOSE_LABEL]);
    r.choose(PRICING_CLOSE_LABEL);
    expect(await r.result).toBe(
      'Not recorded. gpt-5.5 (openai) has no user price to clear — nothing changed.',
    );
    expect(r.commits).not.toHaveBeenCalled();
  });
});

describe('the default is No', () => {
  it('a bare letter, Enter, a paste and an arrow leave the card open and write nothing; only a chord answers', async () => {
    const r = rig();
    await atCard(r);
    r.ui.input('y', none);
    r.ui.input('Y', { ...none, shift: true });
    r.ui.input('', enter);
    r.ui.input('', { ...none, downArrow: true });
    r.ui.paste('y');
    r.ui.paste('\x19');
    await Promise.resolve();
    expect(r.snap().kind, 'still the card').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
    r.at(60_000);
    r.ui.input('n', ctrl);
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
    expect(r.snap().active, 'the flow is ended').toBe(false);
  });

  const answers: Array<[string, (f: Rig) => void]> = [
    ['Ctrl+N', (f) => f.ui.input('n', ctrl)],
    ['Esc', (f) => f.escape()],
    ['Ctrl+C', (f) => f.ui.input('c', ctrl)],
    ['the flow being cancelled under the card', (f) => f.flow.cancel()],
  ];
  it.each(answers)('%s writes nothing, calls no commit and ends the flow', async (_name, press) => {
    const r = rig();
    await atCard(r);
    press(r);
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll(), 'nothing is in the database').toHaveLength(0);
    expect(r.snap().active).toBe(false);
  });

  it('Esc at the card of a CLEAR removes nothing either', async () => {
    const r = rig();
    const seed = r.port.prepare(
      { modelId: 'gpt-5.5', provider: 'openai' },
      { action: 'set', prices: { input: '3', output: '9' } },
    );
    if (!seed.ok) throw new Error(seed.reason);
    seed.commit();
    r.commits.mockClear();
    await r.start(PRICING_ACTION_CLEAR, 'gpt-5.5');
    await r.cardUp();
    r.escape();
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(r.commits).not.toHaveBeenCalled();
    expect(rowsFor('gpt-5.5'), 'the override is still there').toHaveLength(1);
  });

  it('a signal that aborts while the card is open closes it as a No and writes nothing', async () => {
    const channel = createNativePromptChannel({ now: () => 10_000 });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const stop = new AbortController();
    // The Home's own flow hands its abort signal to the card: a Home that is closing aborts it.
    const flow = {
      ...channel.flow,
      begin: () => {
        channel.flow.begin();
        return stop.signal;
      },
    };
    const counted = countingPort([entry('acme-custom-1')]);
    const result = runPricingCard({ flow, port: counted.port });
    const drive = async (
      kind: 'select' | 'text' | 'chord',
      text: string | undefined,
      act: () => void,
    ) => {
      await vi.waitFor(
        () => {
          expect(channel.ui.getSnapshot().kind).toBe(kind);
          if (text !== undefined) expect(channel.ui.getSnapshot().message).toContain(text);
        },
        { timeout: WAIT_MS, interval: 5 },
      );
      act();
    };
    await drive('select', 'what do you want to do', () => channel.ui.input('', enter));
    await drive('select', 'Which model', () => channel.ui.input('', enter));
    for (const field of PRICING_FIELDS)
      await drive('text', field.label, () => {
        if (field.id === 'input') channel.ui.paste('3');
        if (field.id === 'output') channel.ui.paste('9');
        channel.ui.input('', enter);
      });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
      interval: 5,
    });
    stop.abort();
    expect(await result).toBe(PRICING_NOT_RECORDED);
    expect(counted.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
    expect(channel.ui.getSnapshot().active, 'the flow is ended').toBe(false);
  });
});

describe('Yes writes once, through the commit, and only past the chord guard', () => {
  it('Ctrl+Y after the card has settled records the price once; a second Ctrl+Y finds no card and writes nothing more', async () => {
    const r = rig();
    await atCard(r);
    r.ui.input('y', ctrl);
    expect(await r.result).toBe(
      'Set user pricing for acme-custom-1 (openai): input $3/Mtok, output $9/Mtok. It applies to your next run/chat and survives `relavium models refresh`.',
    );
    expect(r.commits).toHaveBeenCalledTimes(1);
    const [row] = rowsFor('acme-custom-1');
    expect(row?.source).toBe('user');
    expect(row?.inputCostPerMtokMicrocents).toBe(300_000_000);
    expect(row?.outputCostPerMtokMicrocents).toBe(900_000_000);
    r.ui.input('y', ctrl); // a held key: there is no card to answer
    await Promise.resolve();
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(rowsFor('acme-custom-1')).toHaveLength(1);
    expect(r.snap().active).toBe(false);
  });

  it('Ctrl+Y inside the dwell is not a Yes: nothing is written until the card has been on screen long enough', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.fill({ input: '3', output: '9' });
    await r.until('chord');
    r.at(0);
    r.ui.shown(r.snap());
    r.at(5); // the frame has just appeared
    r.ui.input('y', ctrl);
    expect(r.snap().kind, 'the card stays').toBe('chord');
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
    r.at(60_000);
    r.ui.input('y', ctrl);
    expect(await r.result).toContain('Set user pricing');
    expect(r.commits).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Y on a card that is not on screen is not a Yes', async () => {
    let now = 0;
    const channel = createNativePromptChannel({ now: () => now });
    channel.ui.bindVisibility(() => false); // the exact frame was never measured and flushed
    const counted = countingPort([entry('acme-custom-1')]);
    const result = runPricingCard({ flow: channel.flow, port: counted.port });
    const answer = async (
      kind: 'select' | 'text',
      text: string,
      keys: () => void,
    ): Promise<void> => {
      await vi.waitFor(
        () => {
          expect(channel.ui.getSnapshot().kind).toBe(kind);
          expect(channel.ui.getSnapshot().message).toContain(text);
        },
        { timeout: WAIT_MS, interval: 5 },
      );
      keys();
    };
    await answer('select', 'what do you want to do', () => channel.ui.input('', enter));
    await answer('select', 'Which model', () => channel.ui.input('', enter));
    for (const field of PRICING_FIELDS)
      await answer('text', field.label, () => {
        if (field.id === 'input') channel.ui.paste('3');
        if (field.id === 'output') channel.ui.paste('9');
        channel.ui.input('', enter);
      });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
      interval: 5,
    });
    now = 0;
    channel.ui.shown(channel.ui.getSnapshot());
    now = 60_000;
    channel.ui.input('y', ctrl);
    expect(channel.ui.getSnapshot().kind).toBe('chord');
    expect(counted.commits).not.toHaveBeenCalled();
    channel.flow.cancel();
    expect(await result).toBe(PRICING_NOT_RECORDED);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('a write the database refuses at the commit is a fixed sentence on the Home, not a fault, and records nothing', async () => {
    const r = rig();
    await atCard(r);
    client.sqlite.pragma('query_only = ON');
    r.ui.input('y', ctrl);
    const notice = await r.result;
    client.sqlite.pragma('query_only = OFF');
    expect(notice).toBe(`Not recorded. ${PRICING_WRITE_FAULT}`);
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(catalog.listAll()).toHaveLength(0);
    expect(r.snap().active, 'the flow is ended').toBe(false);
  });

  it("a second provider's price that appears while the card is open is refused at Yes, in the shell's words, and nothing is written", async () => {
    const r = rig();
    await atCard(r);
    // A `models pricing acme-custom-1 --provider deepseek` from another terminal, while the card is open.
    const deepseekId = createProviderStore(client.db, { uuid: () => randomUUID(), now: () => 1 })
      .list()
      .find((provider) => provider.name === 'deepseek')?.id;
    if (deepseekId === undefined) throw new Error('deepseek is not registered');
    catalog.upsert({
      providerId: deepseekId,
      modelId: 'acme-custom-1',
      source: 'user',
      inputCostPerMtokMicrocents: 100_000_000,
      outputCostPerMtokMicrocents: 200_000_000,
    });
    r.ui.input('y', ctrl);
    const notice = await r.result;
    expect(notice).toMatch(
      /^Not recorded\. 'acme-custom-1' is already user-priced under 'deepseek'\./u,
    );
    expect(r.commits).toHaveBeenCalledTimes(1);
    const rows = rowsFor('acme-custom-1');
    expect(rows, 'the commit wrote no row of its own').toHaveLength(1);
    expect(rows[0]?.providerId).toBe(deepseekId);
    expect(r.snap().active, 'the flow is ended').toBe(false);
  });
});

describe('a refusal is a sentence, with a way to change the prices or to close', () => {
  it('the pairing rule: an input without an output is refused in the form\'s words, and "Change the prices" asks again', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.fill({ input: '3' });
    await r.until('select', 'Not recorded.');
    // The output is missing; the form says so by label, never by flag.
    expect(r.snap().message).toContain('Output price is missing');
    expect(r.snap().message).not.toContain('--');
    expect(r.snap().options.map((option) => option.label)).toEqual([
      PRICING_EDIT_LABEL,
      PRICING_CLOSE_LABEL,
    ]);
    expect(catalog.listAll()).toHaveLength(0);

    r.choose(PRICING_EDIT_LABEL);
    await r.fill({ input: '3', output: '9' });
    await r.cardUp();
    expect(r.snap().details).toContain('output      $9/Mtok');
    r.ui.input('y', ctrl);
    expect(await r.result).toContain('input $3/Mtok, output $9/Mtok');
    expect(rowsFor('acme-custom-1')).toHaveLength(1);
  });

  it('the pairing rule: an input beside a media price is "set together", and Close writes nothing', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'gpt-5.5');
    await r.fill({ input: '3', image: '0.04' });
    await r.until('select', 'Not recorded.');
    expect(r.snap().message).toContain('Input price and Output price are set together');
    r.choose(PRICING_CLOSE_LABEL);
    expect(await r.result).toMatch(
      /^Not recorded\. Input price and Output price are set together/u,
    );
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('a media price alone on a model nothing prices for tokens is refused, by the same core rule as the shell', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.fill({ image: '0.04' });
    await r.until('select', 'Not recorded.');
    expect(r.snap().message).toContain('has no token price');
    r.choose(PRICING_CLOSE_LABEL);
    await r.result;
    expect(catalog.listAll()).toHaveLength(0);
  });
});

describe('Esc steps back, and leaving the first question leaves the form', () => {
  it('Esc at a field returns to the previous question, and Esc at the first question writes nothing', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.until('text', 'Input price');
    r.escape();
    await r.until('select', 'Which model');
    r.escape();
    await r.until('select', 'what do you want to do');
    r.escape();
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll()).toHaveLength(0);
    expect(r.snap().active).toBe(false);
  });

  it('Ctrl+C at a field leaves the form from anywhere', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_SET, 'acme-custom-1');
    await r.until('text', 'Input price');
    r.ui.input('c', ctrl);
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('a CLEAR does not ask for prices', async () => {
    const r = rig();
    await r.start(PRICING_ACTION_CLEAR, 'gpt-5.5');
    await r.until('select', 'Not recorded.'); // no override: refused before any price is asked
    expect(r.snap().message).not.toContain('Input price');
    r.choose(PRICING_CLOSE_LABEL);
    await r.result;
  });
});

describe('a model the list does not show', () => {
  it('asks for the id and the provider, then the same questions, and records under that id and provider', async () => {
    const r = rig();
    await r.until('select', 'what do you want to do');
    r.choose(PRICING_ACTION_SET);
    await r.until('select', 'Which model');
    r.choose(PRICING_OTHER_MODEL);
    await r.until('text', 'Model id');
    r.type('house-model');
    await r.until('select', "Which provider serves 'house-model'");
    expect(
      r
        .snap()
        .options.map((option) => option.label)
        .sort(),
    ).toEqual(['deepseek', 'openai']);
    r.choose('deepseek');
    await r.fill({ input: '1', output: '2' });
    await r.cardUp();
    expect(r.snap().message).toBe("Record your price for 'house-model' under deepseek?");
    r.ui.input('y', ctrl);
    expect(await r.result).toContain('Set user pricing for house-model (deepseek)');
    expect(rowsFor('house-model')).toHaveLength(1);
  });

  it('Esc at the provider asks for the id again, and Esc at the id returns to the list', async () => {
    const r = rig();
    await r.until('select', 'what do you want to do');
    r.choose(PRICING_ACTION_SET);
    await r.until('select', 'Which model');
    r.choose(PRICING_OTHER_MODEL);
    await r.until('text', 'Model id');
    r.type('house-model');
    await r.until('select', 'Which provider');
    r.escape();
    await r.until('text', 'Model id');
    r.escape();
    await r.until('select', 'Which model');
    r.escape();
    await r.until('select', 'what do you want to do');
    r.escape();
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('refuses in the prompt an id it cannot show faithfully, and an empty one', () => {
    expect(pricingModelIdIssue('')).toBe('Type a model id.');
    expect(pricingModelIdIssue('   ')).toBe('Type a model id.');
    expect(pricingModelIdIssue('x'.repeat(201))).toBe(PRICING_MODEL_ID_FAULTS['too-long']);
    expect(pricingModelIdIssue('x'.repeat(81))).toBe(PRICING_MODEL_ID_FAULTS['too-long']);
    expect(pricingModelIdIssue('x'.repeat(80))).toBeUndefined();
    expect(pricingModelIdIssue(`a${String.fromCodePoint(0x202e)}b`)).toContain(
      'cannot be shown safely',
    );
    expect(pricingModelIdIssue('gpt-5.5')).toBeUndefined();
    // Spaces around a typed id are dropped before it is judged: it is the id inside them that is recorded.
    expect(pricingModelIdIssue('  gpt-5.5  ')).toBeUndefined();
  });

  it('the prompt refuses an invisible character in a typed id, and the id it would have recorded is never asked about', async () => {
    const r = rig();
    await r.until('select', 'what do you want to do');
    r.choose(PRICING_ACTION_SET);
    await r.until('select', 'Which model');
    r.choose(PRICING_OTHER_MODEL);
    await r.until('text', 'Model id');
    // Built from code points: a literal zero-width space would be invisible in this very file.
    // (U+FEFF is not here: `trim()` drops it from the typed text, so what is recorded is the id without it, which the card shows.)
    for (const code of [0x200b, 0x2060, 0x200e, 0x00ad, 0xe0041]) {
      r.type(`gpt-5${String.fromCodePoint(code)}`);
      await vi.waitFor(() => expect(r.snap().error).toBe(PRICING_MODEL_ID_FAULTS.invisible), {
        timeout: WAIT_MS,
        interval: 5,
      });
      expect(r.snap().kind, 'the prompt stays open').toBe('text');
      // Clear the line (the host's backspace removes one code point).
      for (let i = 0; i < 6; i += 1) r.ui.input('', { ...none, backspace: true });
    }
    r.escape();
    await r.until('select', 'Which model');
    r.escape();
    await r.until('select', 'what do you want to do');
    r.escape();
    expect(await r.result).toBe(PRICING_NOT_RECORDED);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it("a decoy the catalog lists is refused when it is picked, in the card's place, and writes nothing", async () => {
    const listed = `gpt-5.5${String.fromCodePoint(0x200b)}`;
    const r = rig([entry('gpt-5.5', { pricingSource: 'catalog' }), entry(listed)]);
    await r.until('select', 'what do you want to do');
    r.choose(PRICING_ACTION_SET);
    await r.until('select', 'Which model');
    // The two ids read the same in the list; the second is the decoy, and is the one picked.
    expect(r.snap().options.map((option) => option.label)).toHaveLength(3);
    const options = r.snap().options;
    r.ui.input('', { ...none, downArrow: true });
    expect(r.snap().selected).toBe(1);
    expect(options[1]?.label.replaceAll(String.fromCodePoint(0x200b), '')).toBe('gpt-5.5');
    r.ui.input('', enter);
    await r.fill({ input: '3', output: '9' });
    await r.until('select', 'Not recorded.');
    expect(r.snap().message).toContain(PRICING_MODEL_ID_FAULTS.invisible);
    r.choose(PRICING_CLOSE_LABEL);
    expect(await r.result).toBe(`Not recorded. ${PRICING_MODEL_ID_FAULTS.invisible}`);
    expect(r.commits).not.toHaveBeenCalled();
    expect(catalog.listAll(), 'the decoy was not written as a row of its own').toHaveLength(0);
  });
});

describe('the form opens only while the Home is admitting', () => {
  it('asks nothing and begins no flow when the Home is closing', async () => {
    const channel = createNativePromptChannel();
    const counted = countingPort([entry('acme-custom-1')]);
    const begin = vi.spyOn(channel.flow, 'begin');
    await expect(
      runPricingCard({
        flow: channel.flow,
        port: counted.port,
        assertAdmitting: () => {
          throw new Error('Home is closing');
        },
      }),
    ).rejects.toThrow('Home is closing');
    expect(begin).not.toHaveBeenCalled();
    expect(channel.ui.getSnapshot().active).toBe(false);
  });
});
