import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.GLASSHOUSE_BUILD_DIRECTORY || ".next",
  reactStrictMode: true,
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  poweredByHeader: false,
};
export default nextConfig;
