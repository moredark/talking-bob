-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dailyPromptEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dailyPromptHour" INTEGER NOT NULL DEFAULT 13,
ADD COLUMN     "dailyPromptMinute" INTEGER NOT NULL DEFAULT 0;
