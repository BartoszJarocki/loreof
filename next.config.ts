import type { NextConfig } from 'next';
import { withBotId } from 'botid/next/config';
import { withWorkflow } from 'workflow/next';

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/api/snapshots/:id/:part(map|touches|paths)',
        headers: [{ key: 'Content-Encoding', value: 'gzip' }],
      },
    ];
  },
  outputFileTracingIncludes: {
    '/*': ['./.generated/analysis.mjs', './.generated/runner.mjs'],
  },
};

export default withWorkflow(withBotId(config));
