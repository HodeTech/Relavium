import type { ToolHost } from '@relavium/core';

import { sanitizeInline } from '../render/tui/chat-projection.js';

/**
 * The `/doctor` health-check core (2.5.C S5) — a staged check of the local setup, surfaced as a notice (chat) or
 * the Home output overlay. PURE + framework-free: every check takes an injected probe and returns a structured
 * {@link DoctorCheck}, so the fast tier is unit-tested with no real keychain / config / FS, and the **`--deep`**
 * tier (provider-key validation + MCP connectivity) injects its async probes so the secret-redaction + the
 * bounded-timeout discipline live in ONE tested place. The report is rendered by {@link formatDoctorReport};
 * every detail string is sanitized + secret-free by construction.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** One health check's outcome — `detail` is a short, secret-free, single-line summary. */
export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
}

/** Construct an `ok` / `fail` / `warn` check — shared with the `--deep` probes (doctor-deep.ts). */
export const okCheck = (id: string, label: string, detail: string): DoctorCheck => ({
  id,
  label,
  status: 'ok',
  detail,
});
export const failCheck = (id: string, label: string, detail: string): DoctorCheck => ({
  id,
  label,
  status: 'fail',
  detail,
});
export const warnCheck = (id: string, label: string, detail: string): DoctorCheck => ({
  id,
  label,
  status: 'warn',
  detail,
});

// ── fast-tier checks (local, no network, no secret in flight) ────────────────

/**
 * The OS keychain is reachable. The probe READS a never-set account: a reachable keychain returns `null` (no
 * entry — fine), an unavailable backend throws (`KeychainUnavailableError` from os-keychain). The probe surfaces
 * the failure as `fail`; it never reads or returns any actual secret.
 */
export function checkKeychain(probe: () => void): DoctorCheck {
  try {
    probe();
    return okCheck('keychain', 'OS keychain', 'reachable');
  } catch (err) {
    return failCheck(
      'keychain',
      'OS keychain',
      err instanceof Error ? sanitizeInline(err.message) : 'unavailable',
    );
  }
}

/** The config layer loads + validates (the probe wraps `loadResolvedConfig`, which throws a `ConfigError` whose
 *  detail is a TOML position / Zod path — never the file contents — so it is safe to surface, sanitized). */
export function checkConfig(probe: () => void): DoctorCheck {
  try {
    probe();
    return okCheck('config', 'config', 'valid');
  } catch (err) {
    return failCheck(
      'config',
      'config',
      err instanceof Error ? sanitizeInline(err.message) : 'invalid',
    );
  }
}

/** Which host capability arms are wired (2.5.A: `fs` + `process`; `egress` / `os` land in 2.5.E). A read-only
 *  list of the present arms — the symptom-explainer for the original capability-gap root cause. */
export function checkTools(host: ToolHost): DoctorCheck {
  const wired = (
    [
      ['fs', host.fs],
      ['process', host.process],
      ['egress', host.egress],
      ['os', host.os],
      ['mcp', host.mcp],
    ] as const
  )
    .filter(([, arm]) => arm !== undefined)
    .map(([name]) => name);
  return okCheck('tools', 'wired tools', wired.length > 0 ? wired.join(', ') : 'none');
}

// ── the orchestrator ─────────────────────────────────────────────────────────

/** The injected probes the checks run over — fast tier always; the `--deep` async probes only when present. */
export interface DoctorProbes {
  readonly keychain: () => void;
  readonly config: () => void;
  readonly toolHost: ToolHost;
  /** `--deep`: validate each configured provider key with a minimal live request (redacted on failure). */
  readonly deepProviders?: () => Promise<readonly DoctorCheck[]>;
  /** `--deep`: probe each declared MCP server (bounded timeout, closed immediately). */
  readonly deepMcp?: () => Promise<readonly DoctorCheck[]>;
}

/** Run the staged checks: the fast tier always, the `--deep` tier when requested AND its probes are wired. */
export async function runDoctorChecks(deep: boolean, probes: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkKeychain(probes.keychain),
    checkConfig(probes.config),
    checkTools(probes.toolHost),
  ];
  if (deep) {
    // Run the two deep tiers CONCURRENTLY (each is itself a `Promise.all` over its targets), so the worst case is
    // the slower tier, not their sum. The output order (providers, then MCP) is preserved.
    const [providerChecks, mcpChecks] = await Promise.all([
      probes.deepProviders?.() ?? Promise.resolve<readonly DoctorCheck[]>([]),
      probes.deepMcp?.() ?? Promise.resolve<readonly DoctorCheck[]>([]),
    ]);
    checks.push(...providerChecks, ...mcpChecks);
  }
  return { checks };
}

// ── rendering ────────────────────────────────────────────────────────────────

const GLYPH: Record<DoctorStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** The one-line heading, prefixed with the dominant-severity glyph so the outcome is scannable WITHOUT reading
 *  the words (parity with the Home strip's at-a-glance status). `warn` is visible here so a glanceable read can't
 *  mistake "no keys configured" for healthy; a failure outranks a warning. */
function doctorHeading(failures: number, warnings: number): string {
  if (failures > 0) return `${GLYPH.fail} doctor: ${failures} check(s) failed`;
  if (warnings > 0) return `${GLYPH.warn} doctor: ${warnings} warning(s)`;
  return `${GLYPH.ok} doctor: all checks passed`;
}

/** Format a report as a multi-line, secret-free block: a heading + one `<glyph> <label>: <detail>` row per check.
 *  Both the label AND the detail are sanitized — the Home renders these rows verbatim (no outer scrub like the
 *  chat notice channel), so a label carrying a control char (e.g. a crafted MCP server id) is neutralized here. */
export function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map(
    (check) =>
      `  ${GLYPH[check.status]} ${sanitizeInline(check.label)}: ${sanitizeInline(check.detail)}`,
  );
  const failures = report.checks.filter((check) => check.status === 'fail').length;
  const warnings = report.checks.filter((check) => check.status === 'warn').length;
  return [doctorHeading(failures, warnings), ...rows].join('\n');
}
