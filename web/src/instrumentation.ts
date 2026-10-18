/**
 * Next.js Instrumentation Hook
 *
 * Runs once on Next.js server startup (production mode). Used here to
 * register SIGTERM / SIGINT handlers so the web process closes its
 * long-lived Redis + BullMQ singletons cleanly when the container is
 * stopped (e.g. `docker stop`, Coolify redeploy, k8s pod termination).
 *
 * Why this file exists:
 * - The worker (`worker/src/index.ts`) has had SIGTERM/SIGINT handlers
 *   since v2 day 1, but the web side never did.
 * - The web side holds 6 singleton BullMQ Queues (fast / media / comment
 *   / delete / cleanup / validate), each with its own `redis.duplicate()`
 *   connection, plus the base ioredis singleton from `getRedis()`.
 * - On graceful shutdown these were previously left for the OS to tear
 *   down on `process.exit`. Now they are closed explicitly so
 *   `redis-cli CLIENT LIST` shows a clean QUIT rather than a timeout.
 *
 * This file is purely additive — it does NOT change any request handling
 * behavior. It only runs once at boot to install shutdown handlers and
 * once at shutdown to release resources.
 *
 * BUILD DETAIL:
 * `bullmq` and `ioredis` transitively import Node.js built-ins like
 * `child_process`, `net`, `worker_threads`, `tls`. By default, Next.js's
 * bundler would try to trace their full import graph when this file
 * imports `@/lib/queues/helpers` (which imports `bullmq`), causing
 * "Module not found" errors at build time.
 *
 * This is solved in `next.config.ts`:
 *   - `serverExternalPackages: ["bullmq", "ioredis"]` covers App Router
 *     server components and route handlers.
 *   - A custom `webpack` config pushes them onto `config.externals` for
 *     server builds, which covers `instrumentation.ts` (which
 *     `serverExternalPackages` does NOT cover).
 *
 * With both in place, `bullmq` and `ioredis` become native `require()`
 * calls in ALL server bundles, and are resolved from `node_modules` at
 * runtime (the Dockerfile copies the full `node_modules` into the
 * runner stage).
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not in the Edge runtime or browser bundle).
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Lazy-import inside `register()` so this code never loads in the
  // browser/edge bundle even if tree-shaking misses it.
  const { closeQueues } = await import("@/lib/queues/helpers");
  const { getRedis } = await import("@/lib/redis");

  let shuttingDown = false;

  const cleanup = async (signal: string) => {
    if (shuttingDown) return; // Guard against double-SIGTERM (Docker does this)
    shuttingDown = true;
    console.log(`\n[web] ${signal} received — closing Redis + BullMQ singletons…`);

    try {
      await closeQueues();
    } catch (err) {
      console.error("[web] closeQueues() failed during shutdown:", err);
    }

    try {
      // `quit()` sends QUIT and waits for OK; cleaner than `disconnect()`.
      await getRedis().quit();
    } catch (err) {
      console.error("[web] redis.quit() failed during shutdown:", err);
      try {
        getRedis().disconnect();
      } catch {
        /* swallow */
      }
    }

    console.log(`[web] shutdown cleanup complete.`);
    // NOTE: we do NOT call process.exit() — Next.js owns the process
    // lifecycle and will exit on its own once the signal handler chain
    // finishes. Calling process.exit() here would short-circuit Next.js's
    // own graceful shutdown of in-flight requests.
  };

  process.on("SIGTERM", () => void cleanup("SIGTERM"));
  process.on("SIGINT", () => void cleanup("SIGINT"));

  console.log("[web] Instrumentation registered: SIGTERM/SIGINT cleanup hooks installed.");
}
