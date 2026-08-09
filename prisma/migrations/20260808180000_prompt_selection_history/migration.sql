CREATE INDEX "user_prompts_user_created_id_idx"
ON "user_prompts" ("userId", "createdAt" DESC, "id" DESC);
