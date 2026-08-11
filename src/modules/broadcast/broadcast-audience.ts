import { Prisma } from "@prisma/client";
import { BroadcastFilters } from "./broadcast.contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function broadcastAudienceWhere(filters: BroadcastFilters, now: Date): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {
    status: "active",
    bannedAt: null,
    announcementEnabled: true,
  };
  if (filters.languageLevels.length > 0) {
    where.languageLevel = { in: filters.languageLevels };
  }
  if (filters.dailyPromptEnabled !== "any") {
    where.dailyPromptEnabled = filters.dailyPromptEnabled;
  }
  if (filters.activity === "never") {
    where.lastUserMessageAt = null;
  } else if (filters.activity !== "any") {
    const days = Number(filters.activity.slice(0, -1));
    where.lastUserMessageAt = {
      gte: new Date(now.getTime() - days * DAY_MS),
      lt: now,
    };
  }
  return where;
}

export function normalizeBroadcastFilters(value: unknown): BroadcastFilters {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    languageLevels: Array.isArray(source.languageLevels)
      ? source.languageLevels.filter((item): item is string => typeof item === "string")
      : [],
    activity: typeof source.activity === "string" ? source.activity as BroadcastFilters["activity"] : "any",
    dailyPromptEnabled: typeof source.dailyPromptEnabled === "boolean"
      ? source.dailyPromptEnabled
      : "any",
  };
}

