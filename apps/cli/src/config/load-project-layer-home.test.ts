import { describe, expect, it } from 'vitest';

import type { LoadConfigFileOptions } from './load.js';

describe('loadConfigFile options: the home of a project layer is a required field', () => {
  it('has no default to the process home: a project-layer read that names none does not type-check', () => {
    // The guard is the compiler. A project layer is admitted against the operator home, and the field has no default, so a caller
    // that never resolved one cannot silently be judged by the real home of whoever runs it (review H2). If the field became optional
    // again, the directive below would be unused and `tsc` would fail on it.
    // @ts-expect-error A project-layer read must name the home it is admitted against.
    const missing: LoadConfigFileOptions = { projectLayer: true };
    const named: LoadConfigFileOptions = { projectLayer: true, home: '/operator-home' };
    // An operator-owned file is read with no home: the layer that needs none is not made to invent one.
    const operatorOwned: LoadConfigFileOptions = { selfHealMode: true };
    expect(missing.projectLayer).toBe(true);
    expect(named.projectLayer === true && named.home).toBe('/operator-home');
    expect(operatorOwned.projectLayer).toBeUndefined();
  });
});
