import type { CliIo } from '../process/io.js';

/**
 * Emit each record as one NDJSON line — the `--json` machine contract for the non-streaming read commands
 * (`list`/`logs`/`status`/`gate list`, 2.I). One record per line keeps the CLI to a single machine-output
 * idiom: `run --json` is one `RunEvent` per line ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)),
 * and a read command is one result record per line — both `jq`-friendly, both stdout-pure (diagnostics →
 * stderr). For `logs --json` the records ARE raw `RunEvent`s, so its stream is byte-identical to the run's.
 */
export function writeRecordLines(io: CliIo, records: readonly unknown[]): void {
  for (const record of records) {
    io.writeOut(`${JSON.stringify(record)}\n`);
  }
}
