import type { NextConfig } from "next";

// --------------------------------------------------------------------------
// act_ui is a pure frontend. Every /api and /downloads request is proxied to
// the shubham_agent FastAPI backend (the process that actually talks to MinIO,
// Postgres and the local `aetherion` CLI). Point ACT_BACKEND_URL elsewhere to
// target a different backend host.
// --------------------------------------------------------------------------
const BACKEND = process.env.ACT_BACKEND_URL || "http://localhost:8765";

// Real Aetherion/milkyway platform API, proxied under /rapi/<env> so the browser
// stays same-origin (the pasted token's allowed-origins would otherwise CORS-block
// a direct cross-origin call). The Authorization / x-realm-id headers the client
// sets are forwarded to these destinations.
const LOCAL_API = process.env.ACT_LOCAL_API_URL || "http://localhost:8001/api/v1";
const SBOX_API = process.env.ACT_SBOX_API_URL || "";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/downloads/:path*", destination: `${BACKEND}/downloads/:path*` },
      { source: "/rapi/local/:path*", destination: `${LOCAL_API}/:path*` },
      ...(SBOX_API ? [{ source: "/rapi/sbox/:path*", destination: `${SBOX_API}/:path*` }] : []),
    ];
  },
};

export default nextConfig;
