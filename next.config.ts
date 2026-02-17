import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 1. Configure Headers to allow .wasm files to be served correctly
  async headers() {
    return [
      {
        // Match all files in /wasm/ directory
        source: "/wasm/:path*",
        headers: [
          {
            key: "Content-Type",
            value: "application/wasm",
          },
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
    ];
  },

  // 2. Turbopack Configuration (Next.js 16 format)
  turbopack: {},

  // 3. General Config
  reactStrictMode: true,
};

export default nextConfig;
