// The Self-Hosting mark: a home made of a server.
// A roof (home) over two server units (hosting), with one status light.
// Plain data so the React logo, the generated icons and scripts/brand-assets.mjs all draw the same shape.
// Drawn on a 64 by 64 grid.

export const VIEW = 64;

/** The roof. Stroked, not filled. */
export const ROOF = "M11.5 30 L32 12.5 L52.5 30";
export const ROOF_WIDTH = 6;

/** The two server units. Even-odd fill: the slot and the hole around the light are cut out. */
export const UNIT_TOP =
  "M18 34h28a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" +
  "M20 37.5h12v2H20z" +
  "M38.8 38.5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0-6.4 0z";
export const UNIT_BOTTOM =
  "M18 47h28a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" + "M20 50.5h12v2H20z";

/** The status light, sitting in the hole of the top unit. */
export const LIGHT = { cx: 42, cy: 38.5, r: 2 };

/** Same values as the tokens in globals.css. Hex here because image generators cannot read CSS variables. */
export const BRAND = {
  bg: "#0a0a0a",
  panel: "#131313",
  line: "#262626",
  line2: "#3a3a3a",
  ink: "#f2f2f2",
  muted: "#9a9a9a",
  faint: "#5e5e5e",
  green: "#3ecf74",
  red: "#f8564e",
};

export type Light = "ok" | "down" | "off";

export const LIGHT_HEX: Record<Light, string> = { ok: BRAND.green, down: BRAND.red, off: BRAND.line2 };

/** A full standalone SVG of the mark, for files and favicons. `tile` adds a dark rounded square behind it. */
export function markSvg({ fg = BRAND.ink, light = "ok", tile = false }: { fg?: string; light?: Light; tile?: boolean } = {}): string {
  const body =
    `<path d="${ROOF}" fill="none" stroke="${fg}" stroke-width="${ROOF_WIDTH}" stroke-linejoin="miter"/>` +
    `<path d="${UNIT_TOP}" fill="${fg}" fill-rule="evenodd"/>` +
    `<path d="${UNIT_BOTTOM}" fill="${fg}" fill-rule="evenodd"/>` +
    `<circle cx="${LIGHT.cx}" cy="${LIGHT.cy}" r="${LIGHT.r}" fill="${LIGHT_HEX[light]}"/>`;
  const inner = tile ? `<rect width="64" height="64" rx="14" fill="${BRAND.bg}"/><g transform="translate(4 3) scale(0.875)">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${VIEW}" height="${VIEW}">${inner}</svg>`;
}
