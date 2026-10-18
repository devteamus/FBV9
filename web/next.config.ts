import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker (matches the Dockerfile runner stage)
  output: "standalone",
  // Never expose server-only env vars to the client bundle.
  // Only vars prefixed NEXT_PUBLIC_ reach the browser.
  // (This is Next.js default behavior, but explicit here for clarity.)

  // ─────────────────────────────────────────────────────────────
  // Server-only external packages
  // ─────────────────────────────────────────────────────────────
  // `bullmq` and `ioredis` are Node.js-only libraries that import
  // built-in modules like `child_process`, `net`, `worker_threads`,
  // `tls`, etc. Marking them as `serverExternalPackages` tells Next.js
  // to leave them as native `require()` calls (resolved from
  // `node_modules` at runtime) instead of bundling them, so they are
  // never pulled into any client / edge bundle.
  //
  // This is the officially recommended approach for BullMQ + Next.js:
  // https://nextjs.org/docs/app/api-reference/next-config-js/serverExternalPackages
  serverExternalPackages: ["bullmq", "ioredis"],

  // ─────────────────────────────────────────────────────────────
  // Webpack: force `bullmq` / `ioredis` to be external everywhere
  // ─────────────────────────────────────────────────────────────
  // `serverExternalPackages` only covers App Router server components
  // and route handlers — it does NOT cover `instrumentation.ts`,
  // which Next.js bundles separately for both Node and Edge runtimes.
  // As a result, the bundler still traces `bullmq`'s import graph for
  // the instrumentation chunk and fails with
  // "Module not found: Can't resolve 'child_process'" etc.
  //
  // Adding `bullmq` and `ioredis` to `externalityType: 'node-commonjs'`
  // via the webpack config makes webpack emit `require("bullmq")` /
  // `require("ioredis")` calls instead of bundling their source — for
  // ALL server bundles including instrumentation. The runtime then
  // resolves them from `node_modules`, where they exist in production
  // (the Dockerfile copies the full `node_modules` into the runner
  // stage).
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      // `node-commonjs` externality: webpack emits `require(...)` and
      // the Node runtime resolves from `node_modules`. Both ESM and CJS
      // consumers work because Node's interop handles the bridging.
      if (Array.isArray(config.externals)) {
        config.externals.push({
          bullmq: "commonjs bullmq",
          ioredis: "commonjs ioredis",
        });
      }
    }
    return config;
  },
};

export default nextConfig;
