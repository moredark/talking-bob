-- Run with old update admission drained: all existing learner replies are voice.
ALTER TABLE "users" ADD COLUMN "lastVoiceMessageAt" TIMESTAMPTZ(3);
UPDATE "users" SET "lastVoiceMessageAt" = "lastUserMessageAt";
