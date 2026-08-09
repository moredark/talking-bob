import { computed, reactive, readonly } from "vue";
import { authApi } from "../api/auth.api";
import type { AdminUser } from "../types";

const state = reactive({ user: null as AdminUser | null, isLoading: true, initialized: false });

async function checkAuth() {
  const token = localStorage.getItem("token");
  if (!token) {
    Object.assign(state, { user: null, isLoading: false, initialized: true });
    return;
  }
  state.isLoading = true;
  try {
    state.user = await authApi.me();
  } catch {
    localStorage.removeItem("token");
    state.user = null;
  } finally {
    state.isLoading = false;
    state.initialized = true;
  }
}

async function login(username: string, password: string) {
  const response = await authApi.login(username, password);
  localStorage.setItem("token", response.accessToken);
  state.user = { ...response.user, createdAt: "" };
  state.initialized = true;
}

function logout() {
  localStorage.removeItem("token");
  state.user = null;
  state.isLoading = false;
}

export function useAuth() {
  return { state: readonly(state), isAuthenticated: computed(() => Boolean(state.user)), checkAuth, login, logout };
}
