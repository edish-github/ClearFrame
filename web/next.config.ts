import type { NextConfig } from "next";

const config: NextConfig = {
  // Cloud Run runs the server output; standalone keeps the image small.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: false },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
