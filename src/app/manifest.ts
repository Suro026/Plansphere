import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE.name} — ${SITE.tagline}`,
    short_name: SITE.name,
    description: SITE.description,
    id: "/",
    start_url: "/my-pass",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f3f1ea",
    theme_color: "#f3f1ea",
    lang: "en-IN",
    categories: ["education", "events", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "My pass", url: "/my-pass", description: "Your QR ticket" },
      { name: "Explore fests", url: "/explore" },
      { name: "Scanner", url: "/scan", description: "Gate and meal scanning (staff)" },
    ],
  };
}
