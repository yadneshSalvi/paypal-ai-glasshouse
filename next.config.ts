import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  poweredByHeader: false,
};
export default nextConfig;
