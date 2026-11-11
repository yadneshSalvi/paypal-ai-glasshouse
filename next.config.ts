import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.GLASSHOUSE_BUILD_DIRECTORY || ".next",
  reactStrictMode: true,
  serverExternalPackages: ['@electric-sql/pglite', 'postgres','@paypal/agent-toolkit','axios','pdfkit','fontkit'],
  outputFileTracingIncludes: {'/api/reports/**':['./assets/report-fonts/**/*']},
  poweredByHeader: false,
};
export default nextConfig;
