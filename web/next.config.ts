import type { NextConfig } from 'next'

// Epic H (packaging spike H0): the desktop shell serves this UI from a bundled
// Next.js *standalone* server (`.next/standalone/server.js`) with no dev toolchain.
// `output: 'standalone'` is opt-in behind DESKTOP_BUILD so the Vercel (hosted)
// build is byte-identical to today — Vercel never sets DESKTOP_BUILD, so it takes
// the exact same config path it always has. The desktop build sets DESKTOP_BUILD=1
// AND bakes NEXT_PUBLIC_API_URL=http://127.0.0.1:<port> (the loopback backend).
const isDesktopBuild = process.env.DESKTOP_BUILD === '1'

const nextConfig: NextConfig = {
  // No proxy.ts — use middleware.ts only (Next.js 15 requirement)
  reactStrictMode: true,
  ...(isDesktopBuild ? { output: 'standalone' as const } : {}),
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
}

export default nextConfig
