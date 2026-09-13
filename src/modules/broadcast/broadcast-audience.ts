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
  if (filters.noVoiceForDays !== undefined) {
    const cutoff = new Date(now.getTime() - filters.noVoiceForDays * DAY_MS);
    where.OR = [{ lastUserMessageAt: null }, { lastUserMessageAt: { lt: cutoff } }];
  }
  if (filters.scheduledDeliveryWithinDays !== undefined) {
    const cutoff = new Date(now.getTime() - filters.scheduledDeliveryWithinDays * DAY_MS);
    where.userPrompts = { some: { source: "scheduled", deliveryStatus: "sent", sentAt: { gte: cutoff, lte: now } } };
  }
  return where;
}

function optionalDays(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 365) {
    throw new Error(`Invalid saved broadcast filter: ${name}`);
  }
  return value;
}


export function normalizeBroadcastMessageAction(value: unknown): "open_schedule" | null {
  if (value === undefined || value === null) return null;
  if (value !== "open_schedule") throw new Error("Invalid saved broadcast message action");
  return value;
}

export function normalizeBroadcastFilters(value: unknown): BroadcastFilters {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const noVoiceForDays = optionalDays(source.noVoiceForDays, "noVoiceForDays");
  const scheduledDeliveryWithinDays = optionalDays(source.scheduledDeliveryWithinDays, "scheduledDeliveryWithinDays");
  return {
    languageLevels: Array.isArray(source.languageLevels)
      ? source.languageLevels.filter((item): item is string => typeof item === "string")
      : [],
    activity: typeof source.activity === "string" ? source.activity as BroadcastFilters["activity"] : "any",
    dailyPromptEnabled: typeof source.dailyPromptEnabled === "boolean"
      ? source.dailyPromptEnabled
      : "any",
    ...(noVoiceForDays === undefined ? {} : { noVoiceForDays }),
    ...(scheduledDeliveryWithinDays === undefined ? {} : { scheduledDeliveryWithinDays }),
  };
}

