-- AlterTable: add csvRowIndex column to Post
-- Defaults to 0 (existing rows get 0, which is fine — they are
-- historical uploads whose original CSV order is no longer
-- recoverable; new uploads will set their real 0-based index).
ALTER TABLE "Post" ADD COLUMN "csvRowIndex" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: fast sorted dashboard listing
CREATE INDEX "Post_jobId_csvRowIndex_idx" ON "Post"("jobId", "csvRowIndex");
