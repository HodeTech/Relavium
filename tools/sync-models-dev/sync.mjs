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

import { diffCatalog } from '../../packages/llm/dist/catalog/snapshot-guard.js';
import {
  ModelsDevPayloadSchema,
  normalizeCatalog,
} from '../../packages/llm/dist/catalog/models-dev-schema.js';

const SOURCE_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 30_000;
const SNAPSHOT = fileURLToPath(
  new URL('../../packages/llm/src/catalog/snapshot.ts', import.meta.url),
);

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const ACCEPT_PRICE_CHANGES = argv.has('--accept-price-changes');
const ACCEPT_REMOVALS = argv.has('--accept-removals');

/**
 * The committed snapshot, as DATA — imported from the built module, never regex-parsed from the source text.
 *
 * The first version read the generated file with a regex that required a single-quoted key. Prettier's default
 * `quoteProps: 'as-needed'` unquotes any key that is a valid JS identifier, so `o1` and `o3` were emitted bare —
 * the regex matched 88 of 90 models, those two had NO baseline, and a halved `o1` price passed both money guards
 * in silence. The generated file's exact bytes are prettier's decision, not this tool's; any guard that reads
 * them as TEXT is one formatting default away from going quietly blind. So we diff the data.
 */
async function committedSnapshot() {
  try {
    // A LITERAL specifier, deliberately. The repo's seam fence (ADR-0011) forbids a computed `import()` outside
    // the adapters — a dynamic specifier is exactly how a provider SDK could be smuggled past `@relavium/llm`.
    // The rule is right, and the literal costs nothing. `try` because the very first run has no snapshot yet.
    const { CATALOG_SNAPSHOT } = await import('../../packages/llm/dist/catalog/snapshot.js');
    return CATALOG_SNAPSHOT ?? {};
  } catch {
    return {}; // First run: no baseline exists, so nothing can have "changed".
  }
}

/**
 * A DELIBERATELY locale-independent id comparator. The generated snapshot is byte-compared by CI (`--check`) and
 * feeds a SHA, so its row order must be identical on every machine. `String.prototype.localeCompare` is the
 * opposite of what that needs — it is locale-sensitive (under `tr_TR`, `I`/`i` collate differently than under
 * `en_US`), so a dev and CI would sort the same ids differently and the guard would go red with nothing changed.
 * Bare `<`/`>` compare by UTF-16 code unit: deterministic, locale-free, and exact for ASCII model ids.
 */
function byCodeUnit(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The SHA of OUR NORMALIZED CATALOG — deliberately not of the upstream body.
 *
 * The first version pinned the 3.17 MB upstream payload's hash. But we discard ~97% of it, so ANY byte moving in
 * any of the 162 providers we never import changed the hash, changed this file, and made `--check` report the
 * snapshot STALE when nothing we ship had moved at all. A weekly guard that is red no matter what is not a
 * guard. This hash covers exactly what we ship, so it changes when — and only when — our catalog does.
 */
function catalogSha256(catalog) {
  const canonical = Object.keys(catalog)
    .sort(byCodeUnit)
    .map((id) => `${id}=${JSON.stringify(catalog[id])}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function renderSnapshot(catalog, sha256) {
  const ids = Object.keys(catalog).sort(byCodeUnit);
  const rows = ids
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(catalog[id])},`)
    .join('\n');
  return `// GENERATED FILE — DO NOT EDIT BY HAND. Run \`pnpm sync:models\`.
//
// The model-catalog snapshot (ADR-0071). Source: ${SOURCE_URL}
// Catalog SHA-256: ${sha256}
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

/** The SHA-256 of this catalog's own data — changes when, and only when, what we ship changes. */
export const CATALOG_SHA256 = ${JSON.stringify(sha256)};
`;
}

/**
 * The dropped-model report and the two money guards, factored out of {@link main} so its control flow stays
 * readable. Writes the additive/removal notes to stdout and THROWS on the one thing that must be a human decision:
 * a shipped model whose price MOVED or that VANISHED (each moves how much the ADR-0028 cost cap protects). Reads
 * the module-level `--accept-*` flags.
 */
function enforceMoneyGuards({ dropped, moved, vanished, added }) {
  if (dropped.length > 0) {
    // Never silent: a dropped model is a model whose spend we cannot cap. Say which, and why.
    process.stdout.write(
      `sync-models-dev: dropped ${dropped.length} unpriceable/malformed model(s):\n` +
        dropped.map((d) => `  ${d.provider}/${d.modelId} — ${d.reason}`).join('\n') +
        '\n',
    );
  }

  // VANISHED: a model we already ship is GONE from the new catalog, for ANY reason — upstream deleted it,
  // stopped pricing it, a provider-key edit erased a whole provider, the deny-list started matching it. The
  // previous version could only see models the normalizer explicitly DROPPED; one that simply disappeared from
  // the payload appeared in no list at all and was removed in silence. An absent model is an UNPRICED model, and
  // an unpriced model skips the cost cap entirely. A DELIBERATE removal is real (a provider retires a model), so
  // it is expressible — `--accept-removals` — but never the default: the three ways a model can vanish look
  // identical from here, and only one of them is intended.
  if (vanished.length > 0 && !ACCEPT_REMOVALS) {
    throw new Error(
      `sync-models-dev: ${vanished.length} model(s) we already SHIP are GONE from the new catalog:\n` +
        vanished.map((id) => `  ${id}`).join('\n') +
        '\n\nRemoving a model removes its price, and an unpriced model silently skips the ADR-0028 cost cap for ' +
        'users running it TODAY. Find out WHY first — an upstream retirement, a CATALOG_PROVIDER_KEYS edit, and ' +
        'the non-chat filter all look identical from here, and only one of them is intended. Then re-run with ' +
        '--accept-removals to take it in a reviewable diff.',
    );
  }
  if (vanished.length > 0) {
    process.stdout.write(
      `sync-models-dev: took ${vanished.length} accepted removal(s): ${vanished.join(', ')}\n`,
    );
  }

  // MOVED: every money field, not just the flat pair — cache-read, cache-write, and every context tier. The
  // pre-egress estimate takes the HIGHEST applicable tier, so on a long-context turn the TIER rate is the number
  // that sizes the cap. Halving only gemini-2.5-pro's >200k tier moves no flat rate and would have tripped
  // nothing, while capping every long-context turn against half its true cost.
  if (moved.length > 0 && !ACCEPT_PRICE_CHANGES) {
    throw new Error(
      `sync-models-dev: ${moved.length} ALREADY-SHIPPED model(s) changed price:\n` +
        moved.map((m) => `  ${m.modelId}:\n    was ${m.before}\n    now ${m.after}`).join('\n') +
        '\n  (fields: input|output|cacheRead|cacheWrite|tiers, in µ¢/Mtok; `-` = no rate)\n\n' +
        'This is a human decision, not a bot commit — a price feeds the ADR-0028 cost cap, so a rate that ' +
        'silently moves also silently moves how much protection the cap gives. Verify against the provider, ' +
        'then re-run with --accept-price-changes to take them in a reviewable diff.',
    );
  }
  if (added.length > 0) {
    // Additive and safe: pricing a model can only ever INCREASE what the cap covers.
    process.stdout.write(`sync-models-dev: ${added.length} new model(s): ${added.join(', ')}\n`);
  }
}

async function main() {
  process.stdout.write(`sync-models-dev: fetching ${SOURCE_URL}\n`);
  let response;
  try {
    // `redirect: 'error'` — a redirect off models.dev is an ERROR, not a hop (ADR-0071 §8): the destination is a
    // compile-time constant, and a 30x that quietly moved it elsewhere would be the one way this fixed-host path
    // could turn into an attacker-chosen one. A timeout, because a hung sync in CI is a silent one.
    response = await fetch(SOURCE_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Node's fetch reports every transport failure as the bare string "fetch failed" and hides the real reason in
    // `cause`. Surfacing it is the difference between a usable error and a shrug.
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    const what = error instanceof Error ? error.message : String(error);
    throw new Error(`sync-models-dev: could not fetch ${SOURCE_URL} — ${what}${cause}`);
  }
  if (!response.ok) {
    throw new Error(
      `sync-models-dev: ${SOURCE_URL} returned ${response.status} ${response.statusText}`,
    );
  }
  // Bound the upstream body, mirroring the runtime refresh's cap (catalog-refresh.ts): a build tool must not OOM
  // (or write a nonsense catalog) on a misbehaving/hostile host. Pre-check the declared length, then the actual.
  const MAX_BYTES = 16 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(
      `sync-models-dev: ${SOURCE_URL} declares ${declared} bytes, over the ${MAX_BYTES}-byte cap — refusing`,
    );
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) {
    throw new Error(
      `sync-models-dev: ${SOURCE_URL} returned ${body.length} bytes, over the ${MAX_BYTES}-byte cap — refusing`,
    );
  }

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

  // THE TWO MONEY GUARDS — a structural diff of the DATA (see `committedSnapshot`), not a scan of the text.
  const { moved, vanished, added } = diffCatalog(await committedSnapshot(), catalog);
  enforceMoneyGuards({ dropped, moved, vanished, added });

  // FORMAT WITH PRETTIER before comparing or writing. The generated file lives in the repo and is subject to
  // `format:check` like any other source, so the tool must emit byte-for-byte what prettier would. The first
  // version did not — it wrote `JSON.stringify`'s double quotes, prettier rewrote them to single ones, and
  // `--check` then reported the snapshot STALE **even when it was current**. A weekly CI guard that is red no
  // matter what is not a guard: everyone learns to ignore it, and the price-change protection it exists to give
  // quietly evaporates. Formatting here makes the comparison apples-to-apples.
  // `resolveConfig` returns `null` when there is no prettier config; spreading `null` is a legal no-op, so no
  // `?? {}` fallback is needed (and an empty-object literal would be dead weight).
  const rendered = await format(renderSnapshot(catalog, catalogSha256(catalog)), {
    ...(await resolveConfig(SNAPSHOT)),
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
      `sync-models-dev: snapshot is current (${count} models, sha ${catalogSha256(catalog).slice(0, 12)})\n`,
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

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
