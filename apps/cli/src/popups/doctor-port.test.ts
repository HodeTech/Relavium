/**
 * The typed `/doctor` line the hosts route to the popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): exactly `/doctor` and `/doctor --deep`, white space around the words ignored, and nothing else. The hosts call it BEFORE the line is
 * counted as a message, so a line that is not exactly the command must never be taken for it: an ordinary message to the model that merely
 * starts with a word of the command would open a popup (and one that carries `--deep` would arm a confirmation line).
 */
import { describe, expect, it } from 'vitest';

import { parseDoctorLine } from './doctor-port.js';

describe('parseDoctorLine', () => {
  it.each([
    ['/doctor', false],
    ['/doctor --deep', true],
    ['/doctor  --deep', true],
    ['/doctor\t--deep', true],
    ['  /doctor', false],
    ['/doctor  ', false],
    ['  /doctor --deep  ', true],
    ['\t/doctor \t --deep \n', true],
    // The flag repeated asks for the same one thing.
    ['/doctor --deep --deep', true],
  ] as const)('answers %j as a command (deep: %s)', (line, deep) => {
    expect(parseDoctorLine(line)).toEqual({ deep });
  });

  it.each([
    '',
    ' ',
    'hello',
    'thanks',
    'doctor',
    '/doctors',
    '/doctor now',
    '/doctor --deep now',
    '/doctor --deep x',
    '/doctor --deeper',
    '/doctor -deep',
    '/doctor deep',
    '/Doctor',
    '/help',
    '/doctor --verbose',
    'please run /doctor',
  ])('leaves %j to the command’s own dispatch', (line) => {
    expect(parseDoctorLine(line)).toBeUndefined();
  });
});
