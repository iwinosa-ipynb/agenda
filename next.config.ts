import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Creators supply an external profile photo URL for now. Once uploads land
    // this can be narrowed to the storage host(s) we actually use.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
