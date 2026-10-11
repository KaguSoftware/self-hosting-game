import type { Metadata, Viewport } from "next";
import GlobalLayer, { ShakeRoot } from "@/components/GlobalLayer";
import "./globals.css";

export const metadata: Metadata = {
  title: "Self-Hosting",
  description: "Learn self-hosting by doing: Linux, SSH, networking, Docker, Caddy, Postgres, backups, CI/CD.",
};

export const viewport: Viewport = {
  themeColor: "#14100b",
  width: "device-width",
  initialScale: 1,
};

const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=VT323&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>
        <ShakeRoot>{children}</ShakeRoot>
        <GlobalLayer />
      </body>
    </html>
  );
}
