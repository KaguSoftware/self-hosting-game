import type { Metadata, Viewport } from "next";
import GlobalLayer, { ShakeRoot } from "@/components/GlobalLayer";
import { BOOT_SCRIPT } from "@/components/brand/boot";
import "./globals.css";

const DESCRIPTION = "Learn self-hosting by doing: Linux, SSH, networking, Docker, Caddy, Postgres, backups, CI/CD.";

export const metadata: Metadata = {
  metadataBase: new URL("https://self-hosting-game.vercel.app"),
  title: { default: "Self-Hosting", template: "%s · Self-Hosting" },
  description: DESCRIPTION,
  applicationName: "Self-Hosting",
  openGraph: { type: "website", siteName: "Self-Hosting", title: "Self-Hosting", description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: "Self-Hosting", description: DESCRIPTION },
  appleWebApp: { title: "Self-Hosting", capable: true, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

const FONTS =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=VT323&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
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
