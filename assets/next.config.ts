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

  // ⚠️ Default Server Action body size cap is 1MB. Any FormData upload
  // larger than that (e.g. Phase 12 style-reference videos up to 100MB)
  // throws "Body exceeded 1 MB limit" BEFORE your action code runs.
  // Images typically work, videos always fail. See gotcha #35.
  experimental: {
    serverActions: {
      bodySizeLimit: "150mb",
    },
  },
};

export default nextConfig;
