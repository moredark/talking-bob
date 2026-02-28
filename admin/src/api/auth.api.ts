import { apiClient } from "./client";
import type { LoginResponse, AdminUser } from "../types";

export const authApi = {
  login: async (username: string, password: string): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>("/auth/login", {
      username,
      password,
    });
    return response.data;
  },

  me: async (): Promise<AdminUser> => {
    const response = await apiClient.get<AdminUser>("/auth/me");
    return response.data;
  },
};
