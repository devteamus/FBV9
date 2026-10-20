-- Job: user-selected start time (BDT, GMT+6) for the first post.
-- Null = start immediately (legacy behavior / jobs uploaded without a start time).
ALTER TABLE "Job" ADD COLUMN "scheduledStartAt" TIMESTAMP(3);

-- Post: compound index for analytics per-account postedAt range scans
-- (published-in-range, last-publish-per-account) — required at 500-accounts-per-user scale.
CREATE INDEX "Post_accountId_postedAt_idx" ON "Post"("accountId", "postedAt");
