import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GhanaWatch",
    short_name: "GhanaWatch",
    description: "Ghana environmental monitoring and early warning from open satellite data.",
    start_url: "/map",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f7f4",
    theme_color: "#0f3d2e",
    lang: "en",
    categories: ["government", "news", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Recent changes", url: "/alerts" },
      { name: "My area", url: "/my-area" },
      { name: "Report", url: "/report" },
    ],
  };
}
