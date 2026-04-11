import { describe, expect, it } from 'vitest';
import { ToolNameEncoder } from '../src/';

describe('ToolNameEncoder', () => {
  const encoder = new ToolNameEncoder();

  describe('encode', () => {
    it('passes through alphanumeric characters unchanged', () => {
      expect(encoder.encode('abc123')).toBe('abc123');
    });

    it('passes through uppercase letters unchanged', () => {
      expect(encoder.encode('ABC')).toBe('ABC');
    });

    it('encodes special characters', () => {
      const encoded = encoder.encode('-');
      expect(encoded).toMatch(/^_[0-9a-z]{2}$/);
      expect(encoded).toMatch(encoder.encode('-'));
    });

    it('encodes spaces', () => {
      const encoded = encoder.encode(' ');
      expect(encoded).toMatch(/^_[0-9a-z]{2}$/);
      expect(encoded).toMatch(encoder.encode(' '));
    });

    it('encodes the sentinel character itself', () => {
      const encoded = encoder.encode('_');
      expect(encoded).toMatch(/^_[0-9a-z]{2}$/);
      expect(encoded).toMatch(encoder.encode('_'));
    });

    it('encodes dots', () => {
      const encoded = encoder.encode('.');
      expect(encoded).toMatch(/^_[0-9a-z]{2}$/);
      expect(encoded).toMatch(encoder.encode('.'));
    });

    it('encodes mixed input', () => {
      const encoded = encoder.encode('hello world');
      expect(encoded).toContain('hello');
      expect(encoded).toContain('world');
      expect(encoded).toContain(encoder.encode(' '));
      // space should be encoded
      expect(encoded).not.toContain(' ');
    });

    it('returns empty string for empty input', () => {
      expect(encoder.encode('')).toBe('');
    });
  });

  describe('decode', () => {
    it('decodes encoded special characters back to original', () => {
      expect(encoder.decode(encoder.encode('-'))).toBe('-');
    });

    it('decodes encoded spaces back to original', () => {
      expect(encoder.decode(encoder.encode(' '))).toBe(' ');
    });

    it('passes through plain alphanumeric characters', () => {
      expect(encoder.decode('abc123')).toBe('abc123');
    });

    it('returns empty string for empty input', () => {
      expect(encoder.decode('')).toBe('');
    });
  });

  describe('round-trip', () => {
    it('round-trips plain alphanumeric strings', () => {
      const input = 'hello123';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });

    it('round-trips strings with spaces', () => {
      const input = 'hello world';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });

    it('round-trips strings with special characters', () => {
      const input = 'foo-bar.baz/qux';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });

    it('round-trips strings with the sentinel character', () => {
      const input = 'foo_bar';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });

    it('round-trips empty string', () => {
      expect(encoder.decode(encoder.encode(''))).toBe('');
    });

    it('round-trips unicode characters', () => {
      const input = 'café';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });

    it('round-trips a realistic tool name', () => {
      const input = 'mcp__my-server__tool_name';
      expect(encoder.decode(encoder.encode(input))).toBe(input);
    });
  });
});
