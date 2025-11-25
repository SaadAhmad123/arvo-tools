import { describe, expect, it } from 'vitest';
import { hello } from '../src';

describe('@arvo-tools/agentic', () => {
  it('should export version', () => {
    expect(hello()).toBeDefined();
    expect(hello()).toBe('world');
  });
});
