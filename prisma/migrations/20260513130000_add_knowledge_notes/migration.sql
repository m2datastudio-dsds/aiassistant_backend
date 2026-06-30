CREATE TABLE "KnowledgeNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeNote_organizationId_userId_updatedAt_idx" ON "KnowledgeNote"("organizationId", "userId", "updatedAt");
CREATE INDEX "KnowledgeNote_userId_createdAt_idx" ON "KnowledgeNote"("userId", "createdAt");

ALTER TABLE "KnowledgeNote"
ADD CONSTRAINT "KnowledgeNote_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeNote"
ADD CONSTRAINT "KnowledgeNote_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
