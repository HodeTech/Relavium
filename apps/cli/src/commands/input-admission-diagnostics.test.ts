import { describe, expect, it } from 'vitest';

import { inputAdmissionMessage } from './inputs.js';

const prefix = 'workflow inputs do not satisfy their declared contracts. ';

describe('declared input-admission diagnostics', () => {
  it('projects only the declared label and structural reason, without value or cause metadata', () => {
    const issues = [
      {
        name: 'count',
        message: 'value is above the declared maximum',
        value: 'opaque-input-value',
        cause: { message: 'opaque-private-cause' },
      },
    ];
    const message = inputAdmissionMessage(issues);
    expect(message).toBe(`${prefix}input 'count': value is above the declared maximum.`);
    expect(message).not.toMatch(/opaque-input-value|opaque-private-cause/);
  });

  it('displays exactly eight issues and signals a ninth without displaying its contents', () => {
    const issues = Array.from({ length: 8 }, (_, index) => ({
      name: `field${index}`,
      message: 'value is below the declared minimum',
    }));
    const complete = inputAdmissionMessage(issues);
    for (const issue of issues)
      expect(complete).toContain(`input '${issue.name}': ${issue.message}`);
    expect(complete).not.toContain('further input issues omitted');
    const overflow = inputAdmissionMessage([
      ...issues,
      { name: 'omitted-field', message: 'omitted-reason' },
    ]);
    expect(overflow).toBe(`${complete.slice(0, -1)}; further input issues omitted.`);
    expect(overflow).not.toMatch(/omitted-field|omitted-reason/);
  });

  it('allows a 128-character declared name and falls back at 129 without printing a prefix', () => {
    const atLimit = 'n'.repeat(128);
    const overLimit = atLimit + 'x';
    expect(inputAdmissionMessage([{ name: atLimit, message: 'required input is missing' }])).toBe(
      `${prefix}input '${atLimit}': required input is missing.`,
    );
    const message = inputAdmissionMessage([
      { name: overLimit, message: 'required input is missing' },
    ]);
    expect(message).toBe(`${prefix}input: required input is missing.`);
    expect(message).not.toContain(atLimit);
  });

  it('keeps a 256-character reason and omits the 257th character', () => {
    const atLimit = 'r'.repeat(256);
    const expected = `${prefix}input 'declared': ${atLimit}.`;
    expect(inputAdmissionMessage([{ name: 'declared', message: atLimit }])).toBe(expected);
    expect(inputAdmissionMessage([{ name: 'declared', message: atLimit + 'X' }])).toBe(expected);
  });

  it('redacts recognised credentials in declared labels and normalized reasons before truncation', () => {
    const credential = 'sk-proj-' + 'x'.repeat(48);
    const splitCredential = 'sk-proj-' + 'x'.repeat(20) + '\u0001' + 'x'.repeat(28);
    const message = inputAdmissionMessage([
      { name: credential, message: 'value does not match the declared pattern' },
      { name: 'declared', message: 'r'.repeat(249) + ' ' + splitCredential },
      { name: 'raw', message: 'r'.repeat(249) + ' ' + credential },
    ]);
    expect(message).toContain("input '[REDACTED]': value does not match the declared pattern");
    expect(message).not.toContain('sk-proj-');
    expect(message).not.toContain('x'.repeat(20));
    // Normalization reveals a different finite match, so the original diagnostic is wholly masked.
    expect(message).toContain("input 'declared': [REDACTED]");
    // A raw credential still crosses the display limit; clipping before redaction would leak it.
    expect(message).toContain(`input 'raw': ${'r'.repeat(249)} [REDAC`);
  });

  it('keeps terminal controls, bidi direction changes and extra rows out of a displayed reason', () => {
    const message = inputAdmissionMessage([
      {
        name: 'declared',
        message: '\u001b[31mvalue\u001b[0m\u0001\u202e is\nnot\tvalid\u2066',
      },
    ]);
    expect(message).toBe(`${prefix}input 'declared': value is not valid.`);
    for (const control of ['\u001b', '\u0001', '\u202e', '\n', '\t', '\u2066'])
      expect(message).not.toContain(control);
  });

  it('uses a generic label for absent or unreferenceable names, preserving prototype-like declared names', () => {
    const reason = 'required input is missing';
    for (const name of ['', 'untrusted.name', 'spoof\u001b[2J\u202e']) {
      expect(inputAdmissionMessage([{ name, message: reason }])).toBe(`${prefix}input: ${reason}.`);
    }
    expect(inputAdmissionMessage([{ message: reason }])).toBe(`${prefix}input: ${reason}.`);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(inputAdmissionMessage([{ name, message: reason }])).toBe(
        `${prefix}input '${name}': ${reason}.`,
      );
    }
  });
});
