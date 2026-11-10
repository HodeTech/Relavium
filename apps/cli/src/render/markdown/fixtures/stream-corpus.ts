export interface StreamCorpusCase {
  readonly source: string;
  readonly chunks: readonly {
    readonly at: number;
    readonly amount: number;
    readonly draw: boolean;
  }[];
  readonly sample: number;
}

export interface StreamCorpusBatch {
  readonly seed: number;
  readonly first: number;
  readonly cases: readonly StreamCorpusCase[];
}

/** Preserve each seed's complete source/chunk/draw RNG sequence across test files. */
export function streamCorpusBatches(initial: number): readonly StreamCorpusBatch[] {
  const tokens = [
    'x',
    'e\u0301',
    '👩‍💻',
    '🇺',
    '\t',
    '**',
    '_',
    '__',
    '~~',
    '*',
    '`',
    '``',
    '\\*',
    '[a](https://x.test)',
    '[**x**](**x**)',
    '\n',
    '  \n',
  ];
  let seed = initial;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const corpus = Array.from({ length: 500 }, (_, sample) => {
    let source = 'p ' + 'x'.repeat(4000 + random(12));
    for (let part = 0; part < 20; part++) source += tokens[random(tokens.length)] ?? '';
    source += '\tEND';
    const chunks: { at: number; amount: number; draw: boolean }[] = [];
    for (let at = 0; at < source.length; ) {
      const amount = 1 + random(53);
      chunks.push({ at, amount, draw: random(10) === 0 });
      at += amount;
    }
    return { source, chunks, sample };
  });
  return Array.from({ length: 20 }, (_, batch) => ({
    seed: initial,
    first: batch * 25,
    cases: corpus.slice(batch * 25, (batch + 1) * 25),
  }));
}
