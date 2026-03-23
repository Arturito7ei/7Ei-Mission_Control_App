import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // No proxy.ts — use middleware.ts only (Next.js 15 requirement)
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
}

export default nextConfig
