import { describe, expect, it } from 'vitest';

import { fetchMediaBytes, streamMediaBytes, type MediaEgressDeps } from './media-egress.js';
import { readBounded, SafeEgressError, streamBounded } from './safe-egress.js';

const original = [1, 2, 3, 4];
type Mode = 'read' | 'stream';
type Shape = 'ordinary' | 'shadowed' | 'Buffer';

function view(shape: Shape): Uint8Array {
  const bytes = shape === 'Buffer' ? Buffer.from(original) : new Uint8Array(original);
  if (shape !== 'ordinary') Object.defineProperty(bytes, 'length', { value: 0 });
  return bytes;
}

async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

async function consume(
  mode: Mode,
  body: AsyncIterable<Uint8Array>,
  limit: number,
  dispose: () => void,
  delivered: () => void,
): Promise<readonly number[]> {
  if (mode === 'read') return [...(await readBounded(body, limit, dispose))];
  const result: number[] = [];
  for await (const bytes of streamBounded(body, limit, dispose)) {
    delivered();
    result.push(...new Uint8Array(bytes));
  }
  return result;
}

async function outcome(action: () => Promise<readonly number[]>) {
  try {
    return { bytes: await action() };
  } catch (error) {
    return { error: error instanceof SafeEgressError ? error.code : 'unexpected' };
  }
}

const matrix = (['read', 'stream'] as const).flatMap((mode) =>
  (['ordinary', 'shadowed', 'Buffer'] as const).flatMap((shape) =>
    [3, 4].map((limit) => ({ mode, shape, limit })),
  ),
);

describe('intrinsic bounded egress bytes', () => {
  it.each(matrix)(
    'EGRESS_INTRINSIC_BOUND: $mode $shape at limit $limit',
    async ({ mode, shape, limit }) => {
      let disposed = 0;
      let delivered = 0;
      const result = await outcome(() =>
        consume(
          mode,
          one(view(shape)),
          limit,
          () => {
            disposed += 1;
          },
          () => {
            delivered += 1;
          },
        ),
      );
      expect(result, 'EGRESS_INTRINSIC_BOUND').toEqual(
        limit === 4 ? { bytes: original } : { error: 'too_large' },
      );
      expect(disposed).toBe(1);
      expect(delivered).toBe(mode === 'stream' && limit === 4 ? 1 : 0);
    },
  );

  it.each(
    (['read', 'stream'] as const).flatMap((mode) =>
      (['shadowed', 'Buffer'] as const).flatMap((shape) =>
        [7, 8].map((limit) => ({ mode, shape, limit })),
      ),
    ),
  )(
    'EGRESS_INTRINSIC_BOUND: cumulative $mode $shape at limit $limit',
    async ({ mode, shape, limit }) => {
      let disposed = 0;
      let delivered = 0;
      const body = (async function* () {
        await Promise.resolve();
        yield view(shape);
        yield view(shape);
      })();
      const result = await outcome(() =>
        consume(
          mode,
          body,
          limit,
          () => {
            disposed += 1;
          },
          () => {
            delivered += 1;
          },
        ),
      );
      expect(result, 'EGRESS_INTRINSIC_BOUND').toEqual(
        limit === 8 ? { bytes: [...original, ...original] } : { error: 'too_large' },
      );
      expect(disposed).toBe(1);
      expect(delivered).toBe(mode === 'stream' ? (limit === 8 ? 2 : 1) : 0);
    },
  );

  it.each(['read', 'stream'] as const)(
    'never executes length or byteLength getters in %s',
    async (mode) => {
      const bytes = new Uint8Array(original);
      let reads = 0;
      for (const property of ['length', 'byteLength']) {
        Object.defineProperty(bytes, property, {
          get: () => {
            reads += 1;
            return 0;
          },
        });
      }
      let disposed = 0;
      const result = await outcome(() =>
        consume(
          mode,
          one(bytes),
          4,
          () => {
            disposed += 1;
          },
          () => {},
        ),
      );
      expect(result, 'EGRESS_INTRINSIC_BOUND').toEqual({ bytes: original });
      expect(reads, 'EGRESS_INTRINSIC_BOUND').toBe(0);
      expect(disposed).toBe(1);
    },
  );

  it.each(['ordinary', 'Buffer'] as const)(
    'EGRESS_BUFFER_OWNERSHIP: owns reused %s before another pull',
    async (shape) => {
      const borrowed = view(shape);
      let completed = false;
      let disposed = 0;
      const body = (async function* () {
        await Promise.resolve();
        yield borrowed;
        borrowed.set([5, 6, 7, 8]);
        yield borrowed;
        completed = true;
      })();
      const result = await outcome(() =>
        consume(
          'read',
          body,
          8,
          () => {
            disposed += 1;
          },
          () => {},
        ),
      );
      expect(result, 'EGRESS_BUFFER_OWNERSHIP').toEqual({ bytes: [1, 2, 3, 4, 5, 6, 7, 8] });
      expect(completed).toBe(true);
      expect(disposed).toBe(1);
    },
  );

  it.each(
    (['read', 'stream'] as const).flatMap((mode) =>
      (['shadowed', 'Buffer'] as const).map((shape) => ({ mode, shape })),
    ),
  )(
    'EGRESS_INTRINSIC_BOUND: media $mode refuses oversized $shape before delivery',
    async ({ mode, shape }) => {
      let disposed = 0;
      let delivered = 0;
      const deps: MediaEgressDeps = {
        resolveHost: () => Promise.resolve(['203.0.113.10']),
        openConnection: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': 'audio/L16' },
            location: undefined,
            body: one(view(shape)),
            dispose: () => {
              disposed += 1;
            },
          }),
      };
      const result = await outcome(async () => {
        if (mode === 'read')
          return [
            ...(await fetchMediaBytes(
              'https://fixture.invalid/pcm',
              { mimeType: 'audio/L16', maxBytes: 3 },
              deps,
            )),
          ];
        const bytes: number[] = [];
        for await (const chunk of streamMediaBytes(
          'https://fixture.invalid/pcm',
          { mimeType: 'audio/L16', maxBytes: 3 },
          deps,
        )) {
          delivered += 1;
          bytes.push(...new Uint8Array(chunk));
        }
        return bytes;
      });
      expect(result, 'EGRESS_INTRINSIC_BOUND').toEqual({ error: 'too_large' });
      expect(delivered).toBe(0);
      expect(disposed).toBe(1);
    },
  );
});
