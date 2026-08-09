import { createRouter, createWebHistory } from "vue-router";
import { useAuth } from "../composables/useAuth";
import AdminLayout from "../components/AdminLayout.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: () => import("../pages/LoginPage.vue"), meta: { public: true } },
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", name: "dashboard", component: () => import("../pages/DashboardPage.vue") },
        { path: "users", name: "users", component: () => import("../pages/UsersPage.vue") },
        { path: "users/:id", name: "user-detail", component: () => import("../pages/UserDetailPage.vue") },
        { path: "prompts", name: "prompts", component: () => import("../pages/PromptsPage.vue") },
        { path: "topics", name: "topics", component: () => import("../pages/TopicsPage.vue") },
        { path: "error-logs", name: "error-logs", component: () => import("../pages/ErrorLogsPage.vue") },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  const { state, isAuthenticated, checkAuth } = useAuth();
  if (!state.initialized) await checkAuth();
  if (!to.meta.public && !isAuthenticated.value) return { name: "login", query: { redirect: to.fullPath } };
  if (to.name === "login" && isAuthenticated.value) return { name: "dashboard" };
});

export default router;
