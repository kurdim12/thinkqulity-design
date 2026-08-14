import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray lockfile in the user profile makes Next guess the wrong workspace
  // root; pin it to this project.
  outputFileTracingRoot: path.join(__dirname),
  // antd v5 ships untranspiled ESM helpers; this keeps the server bundle happy.
  transpilePackages: ['antd', '@ant-design/icons', 'rc-util', 'rc-pagination', 'rc-picker'],
  experimental: {
    // Keeps antd's per-component CSS-in-JS extraction fast in dev.
    optimizePackageImports: ['antd', '@ant-design/icons'],
  },
};

export default nextConfig;
