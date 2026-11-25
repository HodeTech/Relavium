/**
 * The one routing of a typed line to a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "hosts hold no popup logic", §6, §8, §10): which popup a line opens on a host, given what the host has wired, or `undefined` when the line is
 * not one (it then goes on to the host's own dispatch, which judges its arguments). The hosts recognise the line through this one function
 * BEFORE it is counted as a submit (so the popup host's open gate never sees the command's own line as a turn), and each keeps only its own open
 * adapter: the stand-alone chat (`chat-ink.tsx` `submit()`), the Home's landing and the chat the Home hosts (`home-controller.ts`).
 *
 * Built over the three parses of the eager halves (`parseDoctorLine`, `parseReportLine`, `parseSettingsLine`) and the availability of the report
 * and settings tables (`reportAvailable`, `settingsAvailable`), so the forms a popup answers are written once: `/doctor` and `/doctor --deep`;
 * `/agent`, `/cost`, `/cost --release`, `/workflows` and `/help`; the bare `/mode`, `/effort`, `/models` and `/permissions` (a typed argument of a
 * setting applies directly through the dispatch and opens nothing).
 */

import { parseDoctorLine } from './doctor-port.js';
import {
  parseReportLine,
  reportAvailable,
  type ParsedReportLine,
  type ReportsPort,
} from './report-port.js';
import {
  parseSettingsLine,
  settingsAvailable,
  type SettingsKind,
  type SettingsPort,
} from './settings-port.js';

/** Where a line goes: the doctor (on its confirmation line for `--deep`), one of the reports, or one of the settings. */
export type PopupRoute =
  | { readonly kind: 'doctor'; readonly deep: boolean }
  | { readonly kind: 'report'; readonly line: ParsedReportLine }
  | { readonly kind: 'settings'; readonly command: SettingsKind };

/** What the host has wired, as far as the routing needs it. */
export interface PopupRouteAvailability {
  /** The host can open the doctor here (it has a doctor port and a way to open it). */
  readonly doctor: boolean;
  /** The host's report port, when it can open the reports here; a report the port does not hold is not routed (the line prints its text). */
  readonly reports?: ReportsPort | undefined;
  /** The host's settings port, when it can open the settings here; a setting the port cannot open is not routed (the line is dispatched). */
  readonly settings?: SettingsPort | undefined;
}

/** The report `line` opens on a host whose report port is `reports`, or `undefined`. */
function reportRoute(line: string, reports: ReportsPort | undefined): PopupRoute | undefined {
  if (reports === undefined) return undefined;
  const report = parseReportLine(line);
  return report !== undefined && reportAvailable(reports, report.kind)
    ? { kind: 'report', line: report }
    : undefined;
}

/** The setting `line` opens on a host whose settings port is `settings`, or `undefined`. */
function settingsRoute(line: string, settings: SettingsPort | undefined): PopupRoute | undefined {
  if (settings === undefined) return undefined;
  const setting = parseSettingsLine(line);
  return setting !== undefined && settingsAvailable(settings, setting.kind)
    ? { kind: 'settings', command: setting.kind }
    : undefined;
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
  return reportRoute(line, available.reports) ?? settingsRoute(line, available.settings);
}
