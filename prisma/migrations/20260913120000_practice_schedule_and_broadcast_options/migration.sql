ALTER TABLE "users" ADD COLUMN "promptWeekdaysMask" INTEGER NOT NULL DEFAULT 127;
ALTER TABLE "users" ADD CONSTRAINT "users_prompt_weekdays_mask_check" CHECK ("promptWeekdaysMask" BETWEEN 1 AND 127);

ALTER TABLE "broadcasts" ADD COLUMN "messageAction" VARCHAR(32);
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_message_action_check" CHECK ("messageAction" IS NULL OR "messageAction" = 'open_schedule');
