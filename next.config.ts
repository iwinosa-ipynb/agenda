import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Creator profile photos are stored in Vercel Blob (public store), so the
    // remote allow-list is narrowed to that host. Legacy external URLs still
    // render because <Avatar> uses next/image with `unoptimized` (served
    // as-is, bypassing the optimizer's remote-pattern check).
    remotePatterns: [
      { protocol: "https", hostname: "**.public.blob.vercel-storage.com" },
    ],
  },
};

export default nextConfig;
