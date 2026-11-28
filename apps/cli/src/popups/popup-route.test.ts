/**
 * The one routing of a typed line to a report popup (`popup-route.ts`; [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8, §10), over the same typed forms the two parses are tested with: the doctor's and the reports' forms each go to their popup, only where the
 * host wired it, and every other form is left to the host's own dispatch.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReportsPort } from './report-port.js';
import { routePopupLine, type PopupRoute } from './popup-route.js';

/** A port that holds every report: the routing reads only which members are present, never calls one. */
const EVERY_REPORT: ReportsPort = {
  surface: 'standalone-chat',
  agent: () => {
    throw new Error('not called');
  },
  cost: { read: vi.fn(), release: vi.fn() },
  workflows: { read: vi.fn() },
  help: { keys: [] },
};
const EVERYTHING = { doctor: true, reports: EVERY_REPORT } as const;

describe('routePopupLine', () => {
  it.each([
    ['/doctor', { kind: 'doctor', deep: false }],
    ['/doctor --deep', { kind: 'doctor', deep: true }],
    ['/doctor  --deep', { kind: 'doctor', deep: true }],
    ['/doctor\t--deep', { kind: 'doctor', deep: true }],
    ['  /doctor', { kind: 'doctor', deep: false }],
    ['/doctor  ', { kind: 'doctor', deep: false }],
    ['  /doctor --deep  ', { kind: 'doctor', deep: true }],
    ['\t/doctor \t --deep \n', { kind: 'doctor', deep: true }],
    ['/doctor --deep --deep', { kind: 'doctor', deep: true }],
    ['/agent', { kind: 'report', line: { kind: 'agent' } }],
    ['/cost', { kind: 'report', line: { kind: 'cost', release: false } }],
    ['/cost --release', { kind: 'report', line: { kind: 'cost', release: true } }],
    ['/workflows', { kind: 'report', line: { kind: 'workflows' } }],
    ['/help', { kind: 'report', line: { kind: 'help' } }],
    ['  /agent  ', { kind: 'report', line: { kind: 'agent' } }],
    ['\t/cost\t--release\t', { kind: 'report', line: { kind: 'cost', release: true } }],
    ['/cost   --release', { kind: 'report', line: { kind: 'cost', release: true } }],
    ['/cost --release --release', { kind: 'report', line: { kind: 'cost', release: true } }],
  ] satisfies readonly (readonly [string, PopupRoute])[])(
    '%j opens its popup on a host that has every popup',
    (line, route) => {
      expect(routePopupLine(line, EVERYTHING)).toEqual(route);
    },
  );

  it.each([
    '',
    ' ',
    'hello',
    'doctor',
    '/doctors',
    '/doctor now',
    '/doctor --deep now',
    '/doctor --deeper',
    '/doctor -deep',
    '/Doctor',
    '/doctor --verbose',
    'please run /doctor',
    '/agent now',
    '/agent --release',
    '/cost --force',
    '/cost release',
    '/cost --release now',
    '/workflows list',
    '/help me',
    '/help --deep',
    '/AGENT',
    '/agents',
    '/cost--release',
    'hello /help',
    '/permissions',
    '/models',
  ])('%j is left to the host’s own dispatch', (line) => {
    expect(routePopupLine(line, EVERYTHING)).toBeUndefined();
  });

  it('a doctor line is never a report, whatever the host has: without the doctor it goes to the dispatch', () => {
    expect(routePopupLine('/doctor', { doctor: false, reports: EVERY_REPORT })).toBeUndefined();
    expect(
      routePopupLine('/doctor --deep', { doctor: false, reports: EVERY_REPORT }),
    ).toBeUndefined();
  });

  it('a report the host has not wired is not routed: no port, or a port that does not hold it', () => {
    expect(routePopupLine('/help', { doctor: true })).toBeUndefined();
    expect(routePopupLine('/cost --release', { doctor: true, reports: undefined })).toBeUndefined();
    const helpOnly: ReportsPort = { surface: 'home-chat', help: { keys: [] } };
    expect(routePopupLine('/help', { doctor: false, reports: helpOnly })).toEqual({
      kind: 'report',
      line: { kind: 'help' },
    });
    for (const line of ['/agent', '/cost', '/cost --release', '/workflows'])
      expect(routePopupLine(line, { doctor: false, reports: helpOnly }), line).toBeUndefined();
  });

  it('the doctor is routed with no report port at all (the bare Home’s landing)', () => {
    expect(routePopupLine('/doctor --deep', { doctor: true })).toEqual({
      kind: 'doctor',
      deep: true,
    });
  });
});
