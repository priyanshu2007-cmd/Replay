import type { NextConfig } from 'next';

const apiOrigin = process.env.NEXT_PUBLIC_API_URL || '';
const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const connects = ["'self'", apiOrigin, supabaseOrigin].filter(Boolean).join(' ');

// script-src keeps 'unsafe-inline' (Next injects framework inline scripts with
// varying hashes) and 'unsafe-eval' (supabase-js uses new Function internally).
// Both compromises are documented in SECURITY.md; object-src, base-uri,
// frame-ancestors and the connect allowlist stay strict.

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src ${connects || "'self'"}; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
