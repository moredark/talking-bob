import {
  BookOpenText,
  Bot,
  LayoutDashboard,
  MessagesSquare,
  Megaphone,
  ScrollText,
  Settings,
  TriangleAlert,
  Users,
} from "@lucide/vue";

export const adminNavigationItems = [
  { path: "/", label: "Дашборд", icon: LayoutDashboard },
  { path: "/users", label: "Пользователи", icon: Users },
  { path: "/prompts", label: "Промпты", icon: Bot },
  { path: "/topics", label: "Статистика тем", icon: BookOpenText },
  { path: "/sessions", label: "Сессии", icon: MessagesSquare },
  { path: "/broadcasts", label: "Рассылки", icon: Megaphone },
  { path: "/error-logs", label: "Логи ошибок", icon: TriangleAlert },
  { path: "/audit-logs", label: "Аудит", icon: ScrollText },
  { path: "/settings", label: "Настройки", icon: Settings },
] as const;
