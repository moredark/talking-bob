ALTER TABLE "prompts"
ALTER COLUMN "audioFileId" DROP NOT NULL;

UPDATE "prompts"
SET "audioFileId" = NULLIF(BTRIM("audioFileId"), '')
WHERE "audioFileId" IS NOT NULL;
