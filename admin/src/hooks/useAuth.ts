import { useState, useEffect, useCallback } from "react";
import { authApi } from "../api/auth.api";
import type { AdminUser } from "../types";

interface AuthState {
  user: AdminUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  });

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem("token");

    if (!token) {
      setState({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }

    try {
      const user = await authApi.me();
      setState({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem("token");
      setState({ user: null, isAuthenticated: false, isLoading: false });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (username: string, password: string) => {
    const response = await authApi.login(username, password);
    localStorage.setItem("token", response.accessToken);
    setState({
      user: { id: response.user.id, username: response.user.username, createdAt: "" },
      isAuthenticated: true,
      isLoading: false,
    });
  };

  const logout = () => {
    localStorage.removeItem("token");
    setState({ user: null, isAuthenticated: false, isLoading: false });
  };

  return {
    ...state,
    login,
    logout,
    checkAuth,
  };
}
