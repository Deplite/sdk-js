/** Canonical JSON encoding compatible with the Deplite server signature scheme. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(out, value);
  return out.join('');
}

function write(out: string[], v: unknown): void {
  if (v === null || v === undefined) {
    out.push('null');
    return;
  }
  if (typeof v === 'boolean') {
    out.push(v ? 'true' : 'false');
    return;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error('canonical json: non-finite number');
    }
    out.push(Number.isInteger(v) ? v.toFixed(0) : JSON.stringify(v));
    return;
  }
  if (typeof v === 'string') {
    out.push(quote(v));
    return;
  }
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      write(out, v[i]);
    }
    out.push(']');
    return;
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(',');
      const k = keys[i]!;
      out.push(quote(k));
      out.push(':');
      write(out, obj[k]);
    }
    out.push('}');
    return;
  }
  throw new Error(`canonical json: unsupported value ${typeof v}`);
}

function quote(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        r += '\\"';
        break;
      case 0x5c:
        r += '\\\\';
        break;
      case 0x08:
        r += '\\b';
        break;
      case 0x0c:
        r += '\\f';
        break;
      case 0x0a:
        r += '\\n';
        break;
      case 0x0d:
        r += '\\r';
        break;
      case 0x09:
        r += '\\t';
        break;
      default:
        if (c < 0x20) {
          r += '\\u' + c.toString(16).padStart(4, '0');
        } else {
          r += s[i];
        }
    }
  }
  r += '"';
  return r;
}
