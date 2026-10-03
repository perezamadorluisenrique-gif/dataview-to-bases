// A tiny YAML emitter for the shapes a base needs: nested maps, lists, strings, numbers.

export type Yaml = string | number | boolean | Yaml[] | { [key: string]: Yaml };

const PLAIN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);

export function scalar(s: string): string {
  if (PLAIN.test(s) && !RESERVED.has(s.toLowerCase())) return s;
  if (!s.includes("'") && !/[\n\r]/.test(s)) return `'${s}'`;
  return JSON.stringify(s);
}

export function dump(value: Yaml, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'object') {
        const sub = dump(item, indent + 1);
        // "- key: v" keeps the first line on the dash
        out.push(`${pad}- ${sub[0].replace(/^\s+/, '')}`, ...sub.slice(1));
      } else out.push(`${pad}- ${format(item)}`);
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const key = scalar(k);
      if (typeof v === 'object') {
        out.push(`${pad}${key}:`, ...dump(v, indent + 1));
      } else out.push(`${pad}${key}: ${format(v)}`);
    }
    return out;
  }
  return [`${pad}${format(value)}`];
}

function format(v: string | number | boolean): string {
  return typeof v === 'string' ? scalar(v) : String(v);
}
