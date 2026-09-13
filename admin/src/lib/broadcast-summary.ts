import type { BroadcastFilters, BroadcastMessageAction } from "../types";

export function broadcastFilterSummary(filters: BroadcastFilters): string {
  const parts = [
    filters.languageLevels.length ? filters.languageLevels.join(", ") : "Все уровни",
    filters.activity === "any" ? "Любая активность" : filters.activity === "never" ? "Ещё не отвечали" : `Активность за ${filters.activity.slice(0, -1)} дн.`,
    `Вопросы по расписанию: ${filters.dailyPromptEnabled === "any" ? "любое состояние" : filters.dailyPromptEnabled ? "включены" : "выключены"}`,
  ];
  if (filters.noVoiceForDays != null) parts.push(`Нет голосовых ответов: ${filters.noVoiceForDays} дн.`);
  if (filters.scheduledDeliveryWithinDays != null) parts.push(`Доставка вопроса за ${filters.scheduledDeliveryWithinDays} дн.`);
  return parts.join(" · ");
}

export function broadcastActionLabel(action?: BroadcastMessageAction | null): string {
  return action === "open_schedule" ? "Настроить расписание" : "Без кнопки";
}
