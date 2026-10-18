-- ═══════════════════════════════════════════════════════════
-- v2.1 — Comment status tracking, missing-comment management,
--        analytics support. Fully backward-compatible.
--
-- 1. Extend ScheduledComment into a unified comment tracker:
--    source, accountId, fbPostId, attemptCount, lastAttemptAt
-- 2. Status vocabulary: posted → published, plus new
--    processing / needs_review / skipped states.
-- 3. Account.fbPagePictureUrl (page avatar for the overview UI).
-- 4. Backfill: accountId + fbPostId denormalized from Post;
--    attemptCount for terminal rows; "immediate" comment rows
--    created for every published post that had a `comment`
--    configured (so legacy posts get the same tracking/retry
--    capabilities as new ones).
-- ═══════════════════════════════════════════════════════════

-- ── 1. New columns ─────────────────────────────────────────
ALTER TABLE "ScheduledComment" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'csv_delayed';
ALTER TABLE "ScheduledComment" ADD COLUMN "accountId" TEXT;
ALTER TABLE "ScheduledComment" ADD COLUMN "fbPostId" TEXT;
ALTER TABLE "ScheduledComment" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScheduledComment" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

ALTER TABLE "Account" ADD COLUMN "fbPagePictureUrl" TEXT;

-- ── 2. Status vocabulary migration (posted → published) ──
UPDATE "ScheduledComment" SET "status" = 'published' WHERE "status" = 'posted';

-- ── 3. Backfill denormalized account + fb post id ─────────
UPDATE "ScheduledComment" sc
SET "accountId" = p."accountId",
    "fbPostId"  = p."fbPostId"
FROM "Post" p
WHERE sc."postId" = p."id"
  AND (sc."accountId" IS NULL OR sc."fbPostId" IS NULL);

-- ── 4. Backfill attempt count for terminal rows ──────────
-- A row that is already published or failed has had at least
-- one real publishing attempt.
UPDATE "ScheduledComment" SET "attemptCount" = 1
WHERE "status" IN ('published', 'failed') AND "attemptCount" = 0;

-- ── 5. Backfill "immediate" comment rows ──────────────────
-- Every published post whose CSV `comment` column was set now
-- gets a tracked immediate-comment row, derived from the
-- legacy Post.commentPosted / Post.commentError fields:
--   commentPosted = true            → published
--   commentPosted = false + error   → failed (attempted, errored)
--   commentPosted = false, no error → needs_review (outcome unknown)
-- Ids are deterministic ('imm_' || postId) and guarded by a
-- NOT EXISTS so the migration is safe to re-run.
INSERT INTO "ScheduledComment" (
  "id", "postId", "message", "delayMinutes", "source",
  "accountId", "fbPostId", "status", "errorMessage",
  "attemptCount", "lastAttemptAt", "postedAt", "createdAt"
)
SELECT
  'imm_' || p."id",
  p."id",
  p."comment",
  0,
  'immediate',
  p."accountId",
  p."fbPostId",
  CASE
    WHEN p."commentPosted" = true THEN 'published'
    WHEN p."commentError" IS NOT NULL THEN 'failed'
    ELSE 'needs_review'
  END,
  p."commentError",
  CASE WHEN p."commentPosted" = true OR p."commentError" IS NOT NULL THEN 1 ELSE 0 END,
  NULL,
  NULL,
  p."postedAt"
FROM "Post" p
WHERE p."comment" IS NOT NULL
  AND p."status" = 'posted'
  AND NOT EXISTS (
    SELECT 1 FROM "ScheduledComment" x
    WHERE x."postId" = p."id" AND x."source" = 'immediate'
  );

-- ── 6. Indexes for the new query patterns ─────────────────
CREATE INDEX "ScheduledComment_accountId_idx" ON "ScheduledComment"("accountId");
CREATE INDEX "ScheduledComment_accountId_status_idx" ON "ScheduledComment"("accountId", "status");
CREATE INDEX "ScheduledComment_status_postedAt_idx" ON "ScheduledComment"("status", "postedAt");
CREATE INDEX "Post_userId_postedAt_idx" ON "Post"("userId", "postedAt");
