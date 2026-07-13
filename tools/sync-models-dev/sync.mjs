#!/usr/bin/env node
/**
 * Regenerate the model-catalog snapshot from models.dev
 * ([ADR-0071](../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §3).
 *
 *   pnpm sync:models          # fetch, validate, normalize, write, and diff-check
 *   pnpm sync:models --check  # CI: fail if the committed snapshot is stale (writes nothing)
 *
 * This tool is DELIBERATELY thin. The Zod boundary and the whole normalization live in
 * `packages/llm/src/catalog/` — typed, unit-tested, and part of the package — so the transform that decides
 * what a model COSTS is covered by the same test suite as everything else, not by an untested build script.
 * All this file does is fetch bytes, call that transform, and write the result.
 *
 * THE GUARD (§9). A price change on a model we ALREADY SHIP fails the sync. New models merge automatically;
 * a *moved* price on a shipped model is a human decision — pricing feeds a safety control (the ADR-0028 cost
 * cap), and a silent bot commit that halves a rate would silently halve the cap's protection. Re-run with
 * `--accept-price-changes` to take them, deliberately, in a reviewable diff.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
  ModelsDevPayloadSchema,
  normalizeCatalog,
} from '../../packages/llm/dist/catalog/models-dev-schema.js';

const SOURCE_URL = 'https://models.dev/api.json';
const SNAPSHOT = fileURLToPath(
  new URL('../../packages/llm/src/catalog/snapshot.ts', import.meta.url),
);

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const ACCEPT_PRICE_CHANGES = argv.has('--accept-price-changes');

/** The prices in the snapshot that is currently committed — the baseline the guard compares against. */
function committedPrices() {
  let source;
  try {
    source = readFileSync(SNAPSHOT, 'utf8');
  } catch {
    return new Map(); // first run: there is no baseline, so nothing can have "changed".
  }
  const prices = new Map();
  // Read the committed values out of the generated literal rather than importing it: the tool must run even
  // when the snapshot is mid-edit or the package has not been rebuilt.
  const rows = source.matchAll(
    /'([^']+)': \{[^}]*?inputPerMtokMicrocents: (\d+),\s*outputPerMtokMicrocents: (\d+)/gs,
  );
  for (const [, id, input, output] of rows) prices.set(id, `${input}/${output}`);
  return prices;
}

function renderSnapshot(catalog, sha256) {
  const ids = Object.keys(catalog).sort();
  const rows = ids
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(catalog[id])},`)
    .join('\n');
  return `// GENERATED FILE — DO NOT EDIT BY HAND. Run \`pnpm sync:models\`.
//
// The model-catalog snapshot (ADR-0071). Source: ${SOURCE_URL}
// Upstream body SHA-256: ${sha256}
// Models: ${ids.length}
//
// This SHIPS IN THE BINARY on purpose. The cost cap (ADR-0028) is a safety control, and a safety control that
// only works when a third-party host is reachable is not one — so every model here is priced offline, on first
// run, with no network at all. The optional refresh (ADR-0071 §4) is default-OFF and can only ADD to this floor.
//
// Reviewing a diff here is reviewing a MONEY change. A price that moves on a model we already ship fails the
// sync deliberately (\`--accept-price-changes\` to take it) — because a rate that silently halves also silently
// halves the cap's protection.

import type { CatalogSnapshot } from './catalog-model.js';

export const CATALOG_SNAPSHOT: CatalogSnapshot = {
${rows}
};

/** The upstream payload this snapshot was generated from — pinned so a regeneration is verifiable. */
export const CATALOG_SOURCE_SHA256 = ${JSON.stringify(sha256)};
`;
}

async function main() {
  process.stdout.write(`sync-models-dev: fetching ${SOURCE_URL}\n`);
  const response = await fetch(SOURCE_URL, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(
      `sync-models-dev: ${SOURCE_URL} returned ${response.status} ${response.statusText}`,
    );
  }
  const body = await response.text();
  const sha256 = createHash('sha256').update(body).digest('hex');

  // The Zod boundary: a third-party payload becomes Relavium types HERE, and its raw shape goes no further.
  const payload = ModelsDevPayloadSchema.parse(JSON.parse(body));
  const { catalog, dropped } = normalizeCatalog(payload);
  const count = Object.keys(catalog).length;
  if (count === 0) {
    throw new Error(
      'sync-models-dev: the upstream payload yielded ZERO models. Refusing to write an empty catalog — that ' +
        'would leave every model unpriced and silently disable the cost cap. Check CATALOG_PROVIDER_KEYS.',
    );
  }

  const before = committedPrices();

  // A model we ALREADY SHIP must never be dropped silently. Losing its row means losing its price, which means
  // the ADR-0028 cost cap stops applying to a model users are running TODAY — the exact failure this workstream
  // exists to end. A NEW model that upstream cannot describe is merely absent; a shipped one going absent is a
  // regression, and it is fatal.
  const lost = dropped.filter((d) => before.has(d.modelId));
  if (lost.length > 0) {
    throw new Error(
      `sync-models-dev: ${lost.length} model(s) we already SHIP would be dropped:\n` +
        lost.map((d) => `  ${d.provider}/${d.modelId} — ${d.reason}`).join('\n') +
        '\n\nThat would remove their price, and an unpriced model silently skips the cost cap. Fix the schema ' +
        'or the mapping; do not let a shipped model fall out of the catalog.',
    );
  }
  if (dropped.length > 0) {
    // Never silent: a dropped model is a model whose spend we cannot cap. Say which, and why.
    process.stdout.write(
      `sync-models-dev: dropped ${dropped.length} unpriceable/malformed model(s):\n` +
        dropped.map((d) => `  ${d.provider}/${d.modelId} — ${d.reason}`).join('\n') +
        '\n',
    );
  }
  const moved = [];
  for (const [id, model] of Object.entries(catalog)) {
    const was = before.get(id);
    const now = `${model.inputPerMtokMicrocents}/${model.outputPerMtokMicrocents}`;
    if (was !== undefined && was !== now) moved.push(`  ${id}: ${was} → ${now} (µ¢/Mtok in/out)`);
  }
  if (moved.length > 0 && !ACCEPT_PRICE_CHANGES) {
    throw new Error(
      `sync-models-dev: ${moved.length} ALREADY-SHIPPED model(s) changed price:\n${moved.join('\n')}\n\n` +
        'This is a human decision, not a bot commit — a price feeds the ADR-0028 cost cap, so a rate that ' +
        'silently moves also silently moves how much protection the cap gives. Verify against the provider, ' +
        'then re-run with --accept-price-changes to take them in a reviewable diff.',
    );
  }

  // FORMAT WITH PRETTIER before comparing or writing. The generated file lives in the repo and is subject to
  // `format:check` like any other source, so the tool must emit byte-for-byte what prettier would. The first
  // version did not — it wrote `JSON.stringify`'s double quotes, prettier rewrote them to single ones, and
  // `--check` then reported the snapshot STALE **even when it was current**. A weekly CI guard that is red no
  // matter what is not a guard: everyone learns to ignore it, and the price-change protection it exists to give
  // quietly evaporates. Formatting here makes the comparison apples-to-apples.
  const rendered = await format(renderSnapshot(catalog, sha256), {
    ...((await resolveConfig(SNAPSHOT)) ?? {}),
    filepath: SNAPSHOT,
  });
  const current = (() => {
    try {
      return readFileSync(SNAPSHOT, 'utf8');
    } catch {
      return '';
    }
  })();

  if (CHECK_ONLY) {
    if (rendered !== current) {
      throw new Error(
        'sync-models-dev: the committed snapshot is STALE (upstream has moved). Run `pnpm sync:models`.',
      );
    }
    process.stdout.write(
      `sync-models-dev: snapshot is current (${count} models, sha ${sha256.slice(0, 12)})\n`,
    );
    return;
  }

  writeFileSync(SNAPSHOT, rendered);
  const verb = rendered === current ? 'unchanged' : 'UPDATED';
  process.stdout.write(
    `sync-models-dev: ${verb} — ${count} models across ${new Set(Object.values(catalog).map((m) => m.provider)).size} providers\n` +
      (moved.length > 0 ? `sync-models-dev: took ${moved.length} accepted price change(s)\n` : ''),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
