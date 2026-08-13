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
  AdminAuditListItem,
  AdminAuditDetail,
  AuditLogFilters,
  AdminSessionListItem,
  AdminSessionDetail,
  AdminSessionsFilters,
  AdminRuntimeSettings,
  AdminRuntimeSettingsGroup,
  UpdateRuntimeSettingsDto,
  BroadcastPreview,
  BroadcastDetail,
  BroadcastListItem,
  BroadcastListFilters,
  BroadcastRecipientFilters,
  CreateBroadcastDto,
  AdminAnalytics,
  AnalyticsDays,
  Personality,
  CreatePersonalityDto,
  PersonalityRules,
  UpdatePersonalityRulesDto,
  UpdatePersonalityDto,
} from "../types";

export const adminApi = {
  // Dashboard
  getDashboard: async (): Promise<DashboardStats> => {
    const response = await apiClient.get<DashboardStats>("/admin/dashboard");
    return response.data;
  },

  getAnalytics: async (days: AnalyticsDays): Promise<AdminAnalytics> => {
    const response = await apiClient.get<AdminAnalytics>("/admin/analytics", { params: { days } });
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

  // Personalities
  getPersonalities: async (): Promise<Personality[]> => {
    const response = await apiClient.get<Personality[]>("/admin/personalities");
    return response.data;
  },

  getPersonalityRules: async (): Promise<PersonalityRules> => {
    const response = await apiClient.get<PersonalityRules>("/admin/personalities/rules");
    return response.data;
  },

  updatePersonalityRules: async (data: UpdatePersonalityRulesDto): Promise<PersonalityRules> => {
    const response = await apiClient.patch<PersonalityRules>("/admin/personalities/rules", data);
    return response.data;
  },

  createPersonality: async (data: CreatePersonalityDto): Promise<Personality> => {
    const response = await apiClient.post<Personality>("/admin/personalities", data);
    return response.data;
  },

  updatePersonality: async (id: string, data: UpdatePersonalityDto): Promise<Personality> => {
    const response = await apiClient.patch<Personality>(`/admin/personalities/${id}`, data);
    return response.data;
  },

  activatePersonality: async (id: string): Promise<Personality> => {
    const response = await apiClient.post<Personality>(`/admin/personalities/${id}/activate`);
    return response.data;
  },

  deactivatePersonality: async (id: string): Promise<Personality> => {
    const response = await apiClient.post<Personality>(`/admin/personalities/${id}/deactivate`);
    return response.data;
  },

  setDefaultPersonality: async (id: string): Promise<Personality> => {
    const response = await apiClient.post<Personality>(`/admin/personalities/${id}/set-default`);
    return response.data;
  },

  // Error Logs
  getErrorLogs: async (
    page: number = 1,
    limit: number = 50,
    type?: string,
    service?: string,
    correlationId?: string
  ): Promise<PaginatedResult<ErrorLogItem>> => {
    const response = await apiClient.get<PaginatedResult<ErrorLogItem>>(
      "/admin/error-logs",
      {
        params: { page, limit, type, service, correlationId },
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

  // Audit Logs
  getAuditLogs: async (
    page: number = 1,
    limit: number = 50,
    filters: AuditLogFilters = {}
  ): Promise<PaginatedResult<AdminAuditListItem>> => {
    const { actorId, action, entityType, entityId, outcome, from, to } = filters;
    const response = await apiClient.get<PaginatedResult<AdminAuditListItem>>(
      "/admin/audit-logs",
      {
        params: {
          page,
          limit,
          actorId,
          action,
          entityType,
          entityId,
          outcome,
          from,
          to,
        },
      }
    );
    return response.data;
  },

  getAuditLogById: async (id: string): Promise<AdminAuditDetail> => {
    const response = await apiClient.get<AdminAuditDetail>(
      `/admin/audit-logs/${id}`
    );
    return response.data;
  },

  // Sessions
  getSessions: async (
    page: number = 1,
    limit: number = 50,
    filters: AdminSessionsFilters = {}
  ): Promise<PaginatedResult<AdminSessionListItem>> => {
    const {
      userId,
      topic,
      source,
      deliveryStatus,
      conversationStatus,
      generationStatus,
      from,
      to,
    } = filters;
    const response = await apiClient.get<PaginatedResult<AdminSessionListItem>>(
      "/admin/sessions",
      {
        params: {
          page,
          limit,
          userId,
          topic,
          source,
          deliveryStatus,
          conversationStatus,
          generationStatus,
          from,
          to,
        },
      }
    );
    return response.data;
  },

  getSessionById: async (id: string): Promise<AdminSessionDetail> => {
    const response = await apiClient.get<AdminSessionDetail>(
      `/admin/sessions/${id}`
    );
    return response.data;
  },

  getRuntimeSettings: async (): Promise<AdminRuntimeSettings> => {
    const response = await apiClient.get<AdminRuntimeSettings>("/admin/settings");
    return response.data;
  },

  updateProductSettings: async (data: UpdateRuntimeSettingsDto): Promise<AdminRuntimeSettingsGroup> => {
    const response = await apiClient.patch<AdminRuntimeSettingsGroup>("/admin/settings/product", data);
    return response.data;
  },

  updateInfrastructureSettings: async (data: UpdateRuntimeSettingsDto): Promise<AdminRuntimeSettingsGroup> => {
    const response = await apiClient.patch<AdminRuntimeSettingsGroup>("/admin/settings/infrastructure", data);
    return response.data;
  },

  previewBroadcast: async (data: CreateBroadcastDto): Promise<BroadcastPreview> => {
    const response = await apiClient.post<BroadcastPreview>("/admin/broadcasts/preview", data);
    return response.data;
  },

  createBroadcast: async (data: CreateBroadcastDto): Promise<BroadcastDetail> => {
    const response = await apiClient.post<BroadcastDetail>("/admin/broadcasts", data);
    return response.data;
  },

  getBroadcasts: async (
    page: number = 1,
    limit: number = 20,
    filters: BroadcastListFilters = {},
  ): Promise<PaginatedResult<BroadcastListItem>> => {
    const { status, from, to } = filters;
    const response = await apiClient.get<PaginatedResult<BroadcastListItem>>(
      "/admin/broadcasts",
      { params: { page, limit, status, from, to } },
    );
    return response.data;
  },

  getBroadcastById: async (
    id: string,
    recipientPage: number = 1,
    recipientLimit: number = 50,
    filters: BroadcastRecipientFilters = {},
  ): Promise<BroadcastDetail> => {
    const response = await apiClient.get<BroadcastDetail>(`/admin/broadcasts/${id}`, {
      params: { recipientPage, recipientLimit, recipientStatus: filters.recipientStatus },
    });
    return response.data;
  },

  cancelBroadcast: async (id: string): Promise<BroadcastDetail> => {
    const response = await apiClient.post<BroadcastDetail>(`/admin/broadcasts/${id}/cancel`);
    return response.data;
  },
};
