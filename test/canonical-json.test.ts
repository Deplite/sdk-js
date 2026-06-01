import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/internal/canonical-json.js';

describe('canonical json', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]');
  });

  it('escapes the standard short forms', () => {
    expect(canonicalJson({ s: 'ab\nc' })).toBe('{"s":"ab\\nc"}');
    expect(canonicalJson({ s: '\t\r\b' })).toBe('{"s":"\\t\\r\\b"}');
  });

  it('escapes other control characters as \\u00XX', () => {
    expect(canonicalJson({ s: '' })).toBe('{"s":"\\u0001"}');
  });

  it('encodes integers without decimals', () => {
    expect(canonicalJson({ n: 42 })).toBe('{"n":42}');
  });

  it('encodes floats via JSON.stringify', () => {
    expect(canonicalJson({ n: 1.5 })).toBe('{"n":1.5}');
  });

  it('emits null for null and undefined', () => {
    expect(canonicalJson({ a: null, b: undefined })).toBe('{"a":null,"b":null}');
  });

  it('escapes quotes and backslashes', () => {
    expect(canonicalJson({ s: 'he said "hi" \\n' })).toBe('{"s":"he said \\"hi\\" \\\\n"}');
  });
});
