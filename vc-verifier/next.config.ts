import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The container build sets NEXT_OUTPUT=standalone to get a self-contained
  // server (.next/standalone/server.js). Other builds (Vercel, local) are unchanged.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {})
};

export default nextConfig;
