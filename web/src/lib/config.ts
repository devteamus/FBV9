/**
 * Deployment-tunable limits & feature flags (server-side only).
 */

/**
 * Max connected accounts per user. v2.2: raised from 100 → 500.
 * Env-configurable via MAX_ACCOUNTS_PER_USER so operators can tune it
 * per deployment without a code change.
 */
export const MAX_ACCOUNTS_PER_USER = (() => {
  const parsed = parseInt(process.env.MAX_ACCOUNTS_PER_USER || "500", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();
