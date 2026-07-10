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

  it('escapes HTML-sensitive characters like Go encoding/json default mode', () => {
    expect(canonicalJson('a&b')).toBe('"a\\u0026b"');
    expect(canonicalJson('<tag>')).toBe('"\\u003ctag\\u003e"');
    expect(canonicalJson('https://s3.example.com/x?a=1&b=2')).toBe(
      '"https://s3.example.com/x?a=1\\u0026b=2"',
    );
  });

  it('escapes U+2028 and U+2029 line separators', () => {
    expect(canonicalJson('a b')).toBe('"a\\u2028b"');
    expect(canonicalJson('a b')).toBe('"a\\u2029b"');
  });

  it('escapes HTML-sensitive characters in object keys too', () => {
    expect(canonicalJson({ 'a&b': 1 })).toBe('{"a\\u0026b":1}');
  });

  it('emits Go short forms for backspace and form feed', () => {
    // Go encoding/json emits the short forms here, not the \\u0008 / \\u000c long forms.
    expect(canonicalJson('\b\f')).toBe('"\\b\\f"');
  });

  it('encodes top-level scalars', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('x')).toBe('"x"');
  });

  it('encodes empty containers', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('passes non-ASCII text through unescaped', () => {
    expect(canonicalJson('한글 café')).toBe('"한글 café"');
  });

  it('passes DEL (0x7f) through like Go', () => {
    expect(canonicalJson('\u007f')).toBe('"\u007f"');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
  });

  it('throws on unsupported value types', () => {
    expect(() => canonicalJson(() => 1)).toThrow(/unsupported/);
    expect(() => canonicalJson(BigInt(1))).toThrow(/unsupported/);
  });

  it('sorts keys inside arrays of objects', () => {
    expect(canonicalJson([{ b: 1, a: [{ d: 2, c: 3 }] }])).toBe('[{"a":[{"c":3,"d":2}],"b":1}]');
  });

  it('canonicalizes a manifest-like payload with a presigned download_url', () => {
    // Locks in the critical case: the & in the presigned URL must escape so the
    // SDK canonical bytes match the server ed25519 signature input.
    const payload = {
      slug: 'my-app',
      desired: {
        download_url: 'https://s3.example.com/o?a=1&b=2&c=3',
        sequence: 11,
        size: 5000000000,
      },
      issued_at: 1700000000,
    };
    expect(canonicalJson(payload)).toBe(
      '{"desired":{"download_url":"https://s3.example.com/o?a=1\\u0026b=2\\u0026c=3",' +
        '"sequence":11,"size":5000000000},"issued_at":1700000000,"slug":"my-app"}',
    );
  });
});
