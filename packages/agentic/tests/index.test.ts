import { describe, expect, it } from 'vitest';
import { version } from '../src';

describe('@arvo-tools/agentic', () => {
  it('should export version', () => {
    expect(version).toBeDefined();
    expect(typeof version).toBe('string');
  });
});
