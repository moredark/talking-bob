import { apiClient } from "./client";
import type {
  DashboardStats,
  UserListItem,
  UserDetail,
  TopicStats,
  PaginatedResult,
  PromptItem,
  CreatePromptDto,
  UpdatePromptDto,
  UpdateUserDto,
  ErrorLogItem,
} from "../types";

export const adminApi = {
  // Dashboard
  getDashboard: async (): Promise<DashboardStats> => {
    const response = await apiClient.get<DashboardStats>("/admin/dashboard");
    return response.data;
  },

  // Users
  getUsers: async (
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResult<UserListItem>> => {
    const response = await apiClient.get<PaginatedResult<UserListItem>>(
      "/admin/users",
      {
        params: { page, limit },
      }
    );
    return response.data;
  },

  getUserById: async (id: string): Promise<UserDetail> => {
    const response = await apiClient.get<UserDetail>(`/admin/users/${id}`);
    return response.data;
  },

  updateUser: async (id: string, data: UpdateUserDto): Promise<UserDetail> => {
    const response = await apiClient.patch<UserDetail>(
      `/admin/users/${id}`,
      data
    );
    return response.data;
  },

  resetUserProgress: async (id: string): Promise<void> => {
    await apiClient.post(`/admin/users/${id}/reset-progress`);
  },

  // Topics
  getTopics: async (): Promise<TopicStats[]> => {
    const response = await apiClient.get<TopicStats[]>("/admin/topics");
    return response.data;
  },

  // Prompts
  getPrompts: async (
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResult<PromptItem>> => {
    const response = await apiClient.get<PaginatedResult<PromptItem>>(
      "/admin/prompts",
      {
        params: { page, limit },
      }
    );
    return response.data;
  },

  getPromptById: async (id: string): Promise<PromptItem> => {
    const response = await apiClient.get<PromptItem>(`/admin/prompts/${id}`);
    return response.data;
  },

  createPrompt: async (data: CreatePromptDto): Promise<PromptItem> => {
    const response = await apiClient.post<PromptItem>("/admin/prompts", data);
    return response.data;
  },

  updatePrompt: async (
    id: string,
    data: UpdatePromptDto
  ): Promise<PromptItem> => {
    const response = await apiClient.patch<PromptItem>(
      `/admin/prompts/${id}`,
      data
    );
    return response.data;
  },

  deletePrompt: async (id: string): Promise<void> => {
    await apiClient.delete(`/admin/prompts/${id}`);
  },

  // Error Logs
  getErrorLogs: async (
    page: number = 1,
    limit: number = 50,
    type?: string,
    service?: string
  ): Promise<PaginatedResult<ErrorLogItem>> => {
    const response = await apiClient.get<PaginatedResult<ErrorLogItem>>(
      "/admin/error-logs",
      {
        params: { page, limit, type, service },
      }
    );
    return response.data;
  },

  getErrorLogById: async (id: string): Promise<ErrorLogItem> => {
    const response = await apiClient.get<ErrorLogItem>(
      `/admin/error-logs/${id}`
    );
    return response.data;
  },

  clearOldErrorLogs: async (days: number = 30): Promise<{ deleted: number }> => {
    const response = await apiClient.delete<{ deleted: number }>(
      "/admin/error-logs/old",
      {
        params: { days },
      }
    );
    return response.data;
  },
};
