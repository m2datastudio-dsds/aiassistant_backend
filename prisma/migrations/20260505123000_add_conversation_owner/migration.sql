ALTER TABLE "Conversation"
ADD COLUMN "userId" TEXT;

UPDATE "Conversation" AS c
SET "userId" = source."userId"
FROM (
  SELECT DISTINCT ON ("conversationId")
    "conversationId",
    "userId"
  FROM "Message"
  WHERE "userId" IS NOT NULL
  ORDER BY "conversationId", "createdAt" ASC
) AS source
WHERE c."id" = source."conversationId";

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "Conversation_userId_updatedAt_idx"
ON "Conversation"("userId", "updatedAt");
