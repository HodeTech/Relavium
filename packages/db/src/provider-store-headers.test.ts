import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createClient,
  createProviderStore,
  isProviderHeaderPolicyError,
  ProviderHeaderPolicyError,
  runMigrations,
  type DbClient,
  type ProviderStore,
  type ProviderUpsert,
} from './index.js';
import { llmProviders } from './schema.js';

const OPAQUE_NAME = 'x-legacy-custody-marker';
const OPAQUE_VALUE = 'orchid-copper-mosaic';
const LEGACY_JSON = ` { "${OPAQUE_NAME}" : "${OPAQUE_VALUE}", "x-mode" : "benign" } `;
const MESSAGE = 'Provider headers are disabled until keychain custody is implemented.';
const fields = (): ProviderUpsert => ({
  name: 'openai',
  displayName: 'OpenAI',
  baseUrl: 'https://offline.example/v1',
});
const withHeaders = (value: unknown): ProviderUpsert => {
  const input = fields();
  Object.defineProperty(input, 'defaultHeaders', { value, enumerable: true, configurable: true });
  return input;
};
const caught = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
};

let client: DbClient;
let store: ProviderStore;
let touched: number;
const now = vi.fn(() => 2000);
const uuid = vi.fn(() => '00000000-0000-4000-8000-000000000002');
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  touched = 0;
  now.mockClear();
  uuid.mockClear();
  store = createProviderStore(client.db, { now, uuid });
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
});
function seedLegacy(raw = LEGACY_JSON): void {
  client.db
    .insert(llmProviders)
    .values({
      id: '00000000-0000-4000-8000-000000000001',
      ...fields(),
      defaultHeaders: raw,
      apiKeyKeychainRef: 'openai:default',
      createdAt: 1000,
      updatedAt: 1000,
    })
    .run();
}
const rawRow = () =>
  client.db.select().from(llmProviders).where(eq(llmProviders.name, 'openai')).get();
const headerCases: readonly (readonly [string, () => unknown])[] = [
  ['opaque', () => ({ [OPAQUE_NAME]: OPAQUE_VALUE })],
  ['benign', () => ({ 'x-mode': 'benign' })],
  ['empty value', () => ({ 'x-empty': '' })],
  ['hidden member', () => Object.defineProperty({}, OPAQUE_NAME, { value: OPAQUE_VALUE })],
  ['symbol member', () => ({ [Symbol('opaque')]: OPAQUE_VALUE })],
  [
    'getter member',
    () =>
      Object.defineProperty({}, OPAQUE_NAME, {
        get: () => {
          touched++;
          return OPAQUE_VALUE;
        },
        enumerable: true,
      }),
  ],
  [
    'serializer',
    () => ({
      toJSON: () => {
        touched++;
        return { [OPAQUE_NAME]: OPAQUE_VALUE };
      },
    }),
  ],
  ['array', () => []],
  ['map', () => new Map()],
  ['date', () => new Date(0)],
  [
    'foreign prototype',
    () => {
      const value = {};
      Object.setPrototypeOf(value, { inherited: OPAQUE_VALUE });
      return value;
    },
  ],
  ['null', () => null],
  ['number', () => 1],
  ['string', () => OPAQUE_VALUE],
  [
    'throwing reflection',
    () =>
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error(OPAQUE_VALUE);
          },
        },
      ),
  ],
  [
    'throwing prototype',
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error(OPAQUE_VALUE);
          },
        },
      ),
  ],
];

describe.each(['new', 'existing'] as const)('%s provider header admission', (state) => {
  it.each(headerCases)('refuses %s before clock, id or transaction entry', (_label, make) => {
    if (state === 'existing') seedLegacy();
    const before = client.db.select().from(llmProviders).all();
    const transaction = vi.spyOn(client.db, 'transaction');
    const error = caught(() => store.upsert(withHeaders(make())));
    expect(
      {
        refused: isProviderHeaderPolicyError(error),
        rows: client.db.select().from(llmProviders).all(),
        clock: now.mock.calls.length,
        ids: uuid.mock.calls.length,
        transactions: transaction.mock.calls.length,
        touched,
      },
      'PROVIDER_HEADERS_NO_PLAINTEXT',
    ).toEqual({ refused: true, rows: before, clock: 0, ids: 0, transactions: 0, touched: 0 });
    expect(error).toBeInstanceOf(ProviderHeaderPolicyError);
  });

  it('refuses an own field accessor without reading it', () => {
    if (state === 'existing') seedLegacy();
    const input = fields();
    Object.defineProperty(input, 'defaultHeaders', {
      get: () => {
        touched++;
        return {};
      },
    });
    const error = caught(() => store.upsert(input));
    expect(
      { refused: isProviderHeaderPolicyError(error), touched, clock: now.mock.calls.length },
      'PROVIDER_HEADERS_INERT_FIELD',
    ).toEqual({ refused: true, touched: 0, clock: 0 });
  });

  it('refuses an inherited field without reading it', () => {
    if (state === 'existing') seedLegacy();
    const prototype = Object.defineProperty({}, 'defaultHeaders', {
      get: () => {
        touched++;
        return {};
      },
    });
    const input = fields();
    Object.setPrototypeOf(input, prototype);
    const error = caught(() => store.upsert(input));
    expect(
      { refused: isProviderHeaderPolicyError(error), touched, clock: now.mock.calls.length },
      'PROVIDER_HEADERS_INERT_FIELD',
    ).toEqual({ refused: true, touched: 0, clock: 0 });
  });
});

it.each(['omitted', 'undefined', 'plain empty', 'null-prototype empty'])(
  'inserts canonical empty headers for %s',
  (shape) => {
    const empty: Record<string, string> = {};
    if (shape === 'null-prototype empty') Object.setPrototypeOf(empty, null);
    const input =
      shape === 'omitted' ? fields() : withHeaders(shape === 'undefined' ? undefined : empty);
    const result = store.upsert(input);
    expect(
      {
        headers: result.defaultHeaders,
        raw: rawRow()?.defaultHeaders,
        calls: uuid.mock.calls.length,
      },
      'PROVIDER_HEADERS_EMPTY_INSERT',
    ).toEqual({ headers: {}, raw: '{}', calls: 1 });
  },
);

it('trusted reads retain valid legacy maps and safely represent special own names', () => {
  seedLegacy(
    `{"${OPAQUE_NAME}":"${OPAQUE_VALUE}","__proto__":"retained-special","constructor":"retained-name"}`,
  );
  const one = store.get('openai');
  const many = store.list();
  expect(one?.defaultHeaders, 'PROVIDER_HEADERS_TRUSTED_LEGACY').toEqual(
    JSON.parse(rawRow()?.defaultHeaders ?? 'null'),
  );
  expect(many[0]?.defaultHeaders).toEqual(one?.defaultHeaders);
  expect(Object.getPrototypeOf(one?.defaultHeaders)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(one?.defaultHeaders, '__proto__')?.value).toBe(
    'retained-special',
  );
});

it.each(['omitted', 'undefined'])('preserves exact legacy JSON for %s updates', (shape) => {
  seedLegacy();
  const input = shape === 'omitted' ? fields() : withHeaders(undefined);
  const result = store.upsert({ ...input, displayName: 'Updated' });
  expect(
    {
      raw: rawRow()?.defaultHeaders,
      headers: result.defaultHeaders,
      displayName: result.displayName,
      updatedAt: rawRow()?.updatedAt,
    },
    'PROVIDER_HEADERS_PRESERVE_LEGACY',
  ).toEqual({
    raw: LEGACY_JSON,
    headers: { [OPAQUE_NAME]: OPAQUE_VALUE, 'x-mode': 'benign' },
    displayName: 'Updated',
    updatedAt: 2000,
  });
});

it.each(['plain', 'null prototype'])(
  'explicit %s empty map clears legacy headers transactionally',
  (shape) => {
    seedLegacy();
    const empty: Record<string, string> = {};
    if (shape === 'null prototype') Object.setPrototypeOf(empty, null);
    const transaction = vi.spyOn(client.db, 'transaction');
    const result = store.upsert(withHeaders(empty));
    expect(
      {
        raw: rawRow()?.defaultHeaders,
        headers: result.defaultHeaders,
        updatedAt: rawRow()?.updatedAt,
      },
      'PROVIDER_HEADERS_EXPLICIT_CLEAR',
    ).toEqual({ raw: '{}', headers: {}, updatedAt: 2000 });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { behavior: 'immediate' });
  },
);

it('ordinary updates and API-key reference changes do not resurrect cleared headers', () => {
  seedLegacy();
  store.upsert(withHeaders({}));
  store.setKeychainRef('openai', 'openai:synthetic');
  store.clearKeychainRef('openai');
  store.upsert({ ...fields(), displayName: 'Ordinary update' });
  expect(
    {
      raw: rawRow()?.defaultHeaders,
      headers: store.get('openai')?.defaultHeaders,
      ref: store.get('openai')?.apiKeyKeychainRef,
    },
    'PROVIDER_HEADERS_NO_RESURRECTION',
  ).toEqual({ raw: '{}', headers: {}, ref: undefined });
});

it('owns the empty admission branch before clock callbacks can replace the supplied field', () => {
  seedLegacy();
  const input = withHeaders({});
  const callbackStore = createProviderStore(client.db, {
    uuid,
    now: () => {
      Object.defineProperty(input, 'defaultHeaders', {
        value: { [OPAQUE_NAME]: OPAQUE_VALUE },
        configurable: true,
      });
      return 3000;
    },
  });
  const result = callbackStore.upsert(input);
  expect(
    { raw: rawRow()?.defaultHeaders, headers: result.defaultHeaders },
    'PROVIDER_HEADERS_CAPTURE_ONCE',
  ).toEqual({ raw: '{}', headers: {} });
});

it('an uninspectable input refuses with no foreign diagnostic', () => {
  const input = new Proxy(fields(), {
    getOwnPropertyDescriptor: () => {
      throw new Error(OPAQUE_VALUE);
    },
  });
  const error = caught(() => store.upsert(input));
  expect(
    { refused: isProviderHeaderPolicyError(error), clock: now.mock.calls.length },
    'PROVIDER_HEADERS_REFLECTION_REFUSAL',
  ).toEqual({ refused: true, clock: 0 });
});

it.each([`{ "${OPAQUE_NAME}": "${OPAQUE_VALUE}"`, `{"${OPAQUE_NAME}":42}`, '[]', 'null', '1'])(
  'stored corruption remains loud and content-free: %s',
  (raw) => {
    seedLegacy(raw);
    for (const operation of [() => store.get('openai'), () => store.list()]) {
      const error = caught(operation);
      expect(error).toBeInstanceOf(TypeError);
      expect(
        error instanceof Error ? error.message : '',
        'PROVIDER_HEADERS_SAFE_READ_DIAGNOSTIC',
      ).toBe('Stored provider headers are invalid.');
      expect(String(error)).not.toContain(OPAQUE_NAME);
      expect(String(error)).not.toContain(OPAQUE_VALUE);
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
      expect(error instanceof Error ? error.stack : '').not.toContain(OPAQUE_NAME);
      expect(error instanceof Error ? error.stack : '').not.toContain(OPAQUE_VALUE);
    }
  },
);

it('failed legacy decoding rolls an ordinary update back as one transaction', () => {
  seedLegacy(`{"${OPAQUE_NAME}":42}`);
  const before = rawRow();
  expect(() => store.upsert({ ...fields(), displayName: 'Must rollback' })).toThrow(
    'Stored provider headers are invalid.',
  );
  expect(rawRow()).toEqual(before);
});

it('exports a fixed content-free policy error without a payload-bearing cause', () => {
  const error = new ProviderHeaderPolicyError();
  expect({ name: error.name, code: error.code, message: error.message }).toEqual({
    name: 'ProviderHeaderPolicyError',
    code: 'provider_header_policy',
    message: MESSAGE,
  });
  expect(isProviderHeaderPolicyError(error)).toBe(true);
  expect(Reflect.ownKeys(error).sort()).toEqual(['code', 'message', 'name', 'stack']);
  expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(OPAQUE_NAME);
  expect(error.stack).not.toContain(OPAQUE_VALUE);
});

it('structural guard accepts bundled Error identity and refuses getters/lookalikes', () => {
  const bundled = Object.assign(new Error(MESSAGE), {
    name: 'ProviderHeaderPolicyError',
    code: 'provider_header_policy',
  });
  expect(isProviderHeaderPolicyError(bundled)).toBe(true);
  const accessor = Object.defineProperty(new Error(MESSAGE), 'code', {
    get: () => {
      touched++;
      return 'provider_header_policy';
    },
  });
  for (const value of [
    undefined,
    null,
    {},
    { code: 'provider_header_policy' },
    new Error(MESSAGE),
    accessor,
    Object.assign(new Error(OPAQUE_VALUE), {
      name: 'ProviderHeaderPolicyError',
      code: 'provider_header_policy',
    }),
    new Proxy(bundled, {
      getOwnPropertyDescriptor: () => {
        throw new Error(OPAQUE_VALUE);
      },
    }),
  ])
    expect(isProviderHeaderPolicyError(value)).toBe(false);
  expect(touched).toBe(0);
});
