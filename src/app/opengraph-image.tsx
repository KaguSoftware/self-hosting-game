import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND, markSvg } from "@/components/brand/mark";

export const alt = "Self-Hosting: learn to run your own server by doing it.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TOPICS = ["Linux", "SSH", "Networking", "Docker", "Caddy", "Postgres", "Backups", "CI/CD"];

export default async function Image() {
  const font = (w: string) => readFile(join(process.cwd(), `src/app/_brand/IBMPlexMono-${w}.ttf`));
  const [semi, regular] = await Promise.all([font("SemiBold"), font("Regular")]);
  const mark = `data:image/svg+xml;base64,${Buffer.from(markSvg()).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: 64,
          background: BRAND.bg,
          color: BRAND.ink,
          fontFamily: "Plex Mono",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={mark} width={300} height={300} alt="" style={{ position: "absolute", right: 60, top: 150 }} />
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mark} width={64} height={64} alt="" />
          <div style={{ display: "flex", marginLeft: 16, fontSize: 36, fontWeight: 600, letterSpacing: -0.7 }}>
            self-hosting<span style={{ color: BRAND.faint }}>_</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 60, fontSize: 58, fontWeight: 600, letterSpacing: -1.5, lineHeight: 1.08 }}>
          <span>Run your own server.</span>
          <span style={{ color: BRAND.muted }}>Learn it by doing it.</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 40,
            padding: "20px 26px",
            width: 660,
            borderRadius: 16,
            border: `2px solid ${BRAND.line}`,
            background: BRAND.panel,
            fontSize: 24,
            fontWeight: 400,
          }}
        >
          <div style={{ display: "flex" }}>
            <span style={{ color: BRAND.muted }}>you@server:~$&nbsp;</span>
            <span>docker compose up -d</span>
          </div>
          <div style={{ display: "flex", marginTop: 8 }}>
            <span style={{ color: BRAND.muted }}>app is up</span>
            <span style={{ marginLeft: "auto", color: BRAND.green, fontWeight: 600 }}>ok</span>
          </div>
        </div>

        <div style={{ display: "flex", marginTop: "auto", gap: 12, fontSize: 19, color: BRAND.muted }}>
          {TOPICS.map((t) => (
            <span key={t} style={{ display: "flex", padding: "6px 14px", borderRadius: 999, border: `1.5px solid ${BRAND.line2}` }}>
              {t}
            </span>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Plex Mono", data: semi, weight: 600, style: "normal" },
        { name: "Plex Mono", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
