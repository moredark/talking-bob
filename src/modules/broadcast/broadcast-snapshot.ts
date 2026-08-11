import { Prisma } from "@prisma/client";
import { BroadcastFilters } from "./broadcast.contracts";

export function broadcastSnapshotInsert(
  broadcastId: string,
  filters: BroadcastFilters,
  now: Date,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`app_user."status" = 'active'`,
    Prisma.sql`app_user."bannedAt" IS NULL`,
    Prisma.sql`app_user."announcementEnabled" = true`,
  ];
  if (filters.languageLevels.length > 0) {
    conditions.push(Prisma.sql`app_user."languageLevel" IN (${Prisma.join(filters.languageLevels)})`);
  }
  if (filters.dailyPromptEnabled !== "any") {
    conditions.push(Prisma.sql`app_user."dailyPromptEnabled" = ${filters.dailyPromptEnabled}`);
  }
  if (filters.activity === "never") {
    conditions.push(Prisma.sql`app_user."lastUserMessageAt" IS NULL`);
  } else if (filters.activity !== "any") {
    const days = Number(filters.activity.slice(0, -1));
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    conditions.push(Prisma.sql`app_user."lastUserMessageAt" >= ${cutoff}`);
    conditions.push(Prisma.sql`app_user."lastUserMessageAt" < ${now}`);
  }
  return Prisma.sql`
    INSERT INTO "broadcast_recipients" (
      "id", "broadcastId", "userId", "telegramIdSnapshot", "usernameSnapshot",
      "languageLevelSnapshot", "dailyPromptEnabledSnapshot", "announcementEnabledSnapshot",
      "status", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid(), ${broadcastId}::uuid, app_user."id", app_user."telegramId",
      app_user."username", app_user."languageLevel", app_user."dailyPromptEnabled",
      app_user."announcementEnabled", 'pending'::"BroadcastRecipientStatus", ${now}, ${now}
    FROM "users" app_user
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY app_user."id" ASC
    ON CONFLICT ("broadcastId", "userId") DO NOTHING
  `;
}
