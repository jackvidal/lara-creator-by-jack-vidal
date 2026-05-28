import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles a minimal Node server with only the deps it
  // needs into .next/standalone. Required for the Dockerfile to ship a
  // ~250MB image instead of ~500MB (with full node_modules).
  output: "standalone",

  // Allow Next/Image to render any HTTPS source. We deliberately whitelist
  // ** because images come from many sources at runtime: Kie CDN, FAL CDN,
  // Supabase Storage (mirrored copies), and we'd otherwise have to enumerate
  // every dynamic CDN domain.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
