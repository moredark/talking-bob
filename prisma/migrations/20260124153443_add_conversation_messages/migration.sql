-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "userPromptId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "voiceFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_messages_userPromptId_idx" ON "conversation_messages"("userPromptId");

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_userPromptId_fkey" FOREIGN KEY ("userPromptId") REFERENCES "user_prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
