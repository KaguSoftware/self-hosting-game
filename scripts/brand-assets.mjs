// Writes the downloadable brand files in public/brand/ from the one mark in src/components/brand/mark.ts.
// Run: node --experimental-strip-types scripts/brand-assets.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createElement as h } from "react";
import { ImageResponse } from "next/dist/compiled/@vercel/og/index.node.js";
import { BRAND, markSvg } from "../src/components/brand/mark.ts";

const OUT = join(process.cwd(), "public", "brand");
const fonts = [
  { name: "Plex Mono", weight: 600, style: "normal", data: await readFile(join(process.cwd(), "src/app/_brand/IBMPlexMono-SemiBold.ttf")) },
  { name: "Plex Mono", weight: 400, style: "normal", data: await readFile(join(process.cwd(), "src/app/_brand/IBMPlexMono-Regular.ttf")) },
];

const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

async function png(file, el, width, height) {
  const res = new ImageResponse(el, { width, height, fonts });
  await writeFile(join(OUT, file), Buffer.from(await res.arrayBuffer()));
  console.log("wrote", file);
}

function lockup({ fg, bg, scale }) {
  const s = (n) => n * scale;
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", width: "100%", height: "100%", background: bg ?? "transparent", padding: s(24) } },
    h("img", { src: dataUri(markSvg({ fg })), width: s(76), height: s(76) }),
    h(
      "div",
      { style: { display: "flex", marginLeft: s(12), fontFamily: "Plex Mono", fontWeight: 600, fontSize: s(40), letterSpacing: s(-0.8), color: fg } },
      "self-hosting",
      h("span", { style: { color: fg === BRAND.ink ? BRAND.faint : BRAND.muted } }, "_"),
    ),
  );
}

await mkdir(OUT, { recursive: true });

const svgs = {
  "mark.svg": markSvg(),
  "mark-dark-ink.svg": markSvg({ fg: BRAND.bg }),
  "mark-down.svg": markSvg({ light: "down" }),
  "mark-off.svg": markSvg({ light: "off" }),
  "app-icon.svg": markSvg({ tile: true }),
};
for (const [file, svg] of Object.entries(svgs)) {
  await writeFile(join(OUT, file), svg + "\n");
  console.log("wrote", file);
}

const fullBleed = (mark) =>
  h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: BRAND.bg } }, h("img", { src: dataUri(markSvg()), width: mark, height: mark }));
const tile = (size) => h("img", { src: dataUri(markSvg({ tile: true })), width: size, height: size });
for (const size of [192, 512, 1024]) await png(`app-icon-${size}.png`, tile(size), size, size);

// Maskable icons get cropped to a circle by phones, so the mark sits smaller on a full-bleed square.
await png("app-icon-maskable-512.png", fullBleed(300), 512, 512);

// The app's own icons. Apple rounds the corners itself, so its icon is a full square.
await png("../../src/app/apple-icon.png", fullBleed(132), 180, 180);
await writeFile(join(process.cwd(), "src/app/icon.svg"), markSvg({ tile: true }) + "\n");
console.log("wrote src/app/icon.svg");

await png("lockup-light-on-dark.png", lockup({ fg: BRAND.ink, bg: BRAND.bg, scale: 4 }), 1760, 448);
await png("lockup-dark-on-light.png", lockup({ fg: BRAND.bg, bg: "#ffffff", scale: 4 }), 1760, 448);
await png("lockup-transparent.png", lockup({ fg: BRAND.ink, scale: 4 }), 1760, 448);

// Small previews to check the mark still reads at favicon size.
if (process.argv.includes("--preview")) {
  const row = h("div", { style: { display: "flex", alignItems: "center", gap: 12, width: "100%", height: "100%", background: "#ffffff", padding: 12 } }, ...[16, 24, 32, 48].map((s) => tile(s)), ...[16, 24, 32].map((s) => h("div", { style: { display: "flex", background: BRAND.bg, padding: 4 } }, h("img", { src: dataUri(markSvg()), width: s, height: s }))));
  await png(relative(OUT, join(tmpdir(), "brand-preview.png")), row, 300, 72);
}
