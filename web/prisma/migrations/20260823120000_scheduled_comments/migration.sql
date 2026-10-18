-- CreateTable
CREATE TABLE "ScheduledComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fbCommentId" TEXT,
    "errorMessage" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledComment_postId_idx" ON "ScheduledComment"("postId");

-- CreateIndex
CREATE INDEX "ScheduledComment_status_idx" ON "ScheduledComment"("status");

-- AddForeignKey
ALTER TABLE "ScheduledComment" ADD CONSTRAINT "ScheduledComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
