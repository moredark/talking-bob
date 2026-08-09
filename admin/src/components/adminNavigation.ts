import {
  BookOpenText,
  Bot,
  LayoutDashboard,
  TriangleAlert,
  Users,
} from "@lucide/vue";

export const adminNavigationItems = [
  { path: "/", label: "Дашборд", icon: LayoutDashboard },
  { path: "/users", label: "Пользователи", icon: Users },
  { path: "/prompts", label: "Промпты", icon: Bot },
  { path: "/topics", label: "Статистика тем", icon: BookOpenText },
  { path: "/error-logs", label: "Логи ошибок", icon: TriangleAlert },
] as const;
