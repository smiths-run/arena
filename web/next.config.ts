import type { NextConfig } from "next";

const INDEXER = process.env.INDEXER_URL ?? "http://localhost:42069";
const RECEIPTS = process.env.RECEIPTS_URL ?? "http://localhost:42070";

/**
 * The browser only ever talks to this origin; the indexer and the receipts
 * ledger are proxied behind it. No CORS, one base URL for the client code.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/idx/:path*", destination: `${INDEXER}/api/:path*` },
      { source: "/api/runs/:path*", destination: `${RECEIPTS}/:path*` },
    ];
  },
};

export default nextConfig;
