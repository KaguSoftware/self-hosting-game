import type { MetadataRoute } from "next";
import { BRAND } from "@/components/brand/mark";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Self-Hosting",
    short_name: "Self-Hosting",
    description: "Learn to run your own server by doing it, one level at a time.",
    start_url: "/",
    display: "standalone",
    background_color: BRAND.bg,
    theme_color: BRAND.bg,
    icons: [
      { src: "/brand/app-icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
