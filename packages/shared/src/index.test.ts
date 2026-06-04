import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from './index.js';

describe('@relavium/shared scaffold', () => {
  it('pins the schema version at 1.0', () => {
    expect(SCHEMA_VERSION).toBe('1.0');
  });
});
