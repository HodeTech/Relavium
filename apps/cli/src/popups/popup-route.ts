/**
 * The one routing of a typed line to a report popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "hosts hold no popup logic", §8, §10): which popup a line opens on a host, given what the host has wired, or `undefined` when the line is
 * not one (it then goes on to the host's own dispatch, which judges its arguments). The hosts recognise the line where they open a sheet for
 * `/permissions`, BEFORE it is counted as a submit (so the popup host's open gate never sees the command's own line as a turn), and each keeps
 * only its own open adapter: the stand-alone chat (`chat-ink.tsx` `submit()`), the Home's landing and the chat the Home hosts
 * (`home-controller.ts`).
 *
 * Built over the two parses of the eager halves (`parseDoctorLine`, `parseReportLine`) and the report table's availability (`reportAvailable`), so
 * the forms a popup answers are written once: `/doctor` and `/doctor --deep`; `/agent`, `/cost`, `/cost --release`, `/workflows` and `/help`.
 */

import { parseDoctorLine } from './doctor-port.js';
import {
  parseReportLine,
  reportAvailable,
  type ParsedReportLine,
  type ReportsPort,
} from './report-port.js';

/** Where a line goes: the doctor (on its confirmation line for `--deep`), or one of the reports. */
export type PopupRoute =
  | { readonly kind: 'doctor'; readonly deep: boolean }
  | { readonly kind: 'report'; readonly line: ParsedReportLine };

/** What the host has wired, as far as the routing needs it. */
export interface PopupRouteAvailability {
  /** The host can open the doctor here (it has a doctor port and a way to open it). */
  readonly doctor: boolean;
  /** The host's report port, when it can open the reports here; a report the port does not hold is not routed (the line prints its text). */
  readonly reports?: ReportsPort | undefined;
}

/**
 * The popup `line` opens on a host that has `available`, or `undefined`: the line is not exactly one of the forms a popup answers, or the host
 * has not wired the popup it names. White space around the words is ignored.
 */
export function routePopupLine(
  line: string,
  available: PopupRouteAvailability,
): PopupRoute | undefined {
  if (available.doctor) {
    const doctor = parseDoctorLine(line);
    if (doctor !== undefined) return { kind: 'doctor', deep: doctor.deep };
  }
  const reports = available.reports;
  if (reports === undefined) return undefined;
  const report = parseReportLine(line);
  return report !== undefined && reportAvailable(reports, report.kind)
    ? { kind: 'report', line: report }
    : undefined;
}
