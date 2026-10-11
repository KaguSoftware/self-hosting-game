/** Deterministic hex string from any text. */
export function hashHex(text: string, len = 12): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let out = "";
  let i = 0;
  while (out.length < len) {
    for (let j = 0; j < text.length; j++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(j), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (text.charCodeAt(j) + i), 2246822519) >>> 0;
    }
    out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
    i++;
  }
  return out.slice(0, len);
}

/** Deterministic base64-ish string. */
export function hashB64(text: string, len: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const hex = hashHex(text, len * 2);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 64];
  return s;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function humanBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  if (u === 0) return `${v}`;
  return v < 10 ? `${v.toFixed(1)}${units[u]}` : `${Math.round(v)}${units[u]}`;
}

/** Simple glob match supporting * and ? */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(s);
}
