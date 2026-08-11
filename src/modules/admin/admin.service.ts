import { Injectable } from "@nestjs/common";
import {
  AdminAuditLogsQuery,
  AnalyticsDays,
  AdminSessionsQuery,
  BroadcastDetailQuery,
  BroadcastInputDto,
  BroadcastListQuery,
  AdminErrorService,
  AdminErrorType,
  CreatePromptDto,
  UpdatePromptDto,
  UpdateUserDto,
  UpdateRuntimeSettingsDto,
} from "./admin.contracts";
import { AdminAnalyticsService } from "./admin-analytics.service";
import { AdminAuditService } from "./admin-audit.service";
import { AdminBroadcastsService } from "./admin-broadcasts.service";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminErrorLogsService } from "./admin-error-logs.service";
import { AdminPromptsService } from "./admin-prompts.service";
import { AdminSessionsService } from "./admin-sessions.service";
import { AdminUsersService } from "./admin-users.service";

import { AdminSettingsService } from "./admin-settings.service";
export * from "./admin.contracts";

@Injectable()
export class AdminService {
  constructor(
    private readonly broadcasts: AdminBroadcastsService,
    private readonly dashboard: AdminDashboardService,
    private readonly analytics: AdminAnalyticsService,
    private readonly users: AdminUsersService,
    private readonly prompts: AdminPromptsService,
    private readonly errorLogs: AdminErrorLogsService,
    private readonly sessions: AdminSessionsService,
    private readonly audit: AdminAuditService,
    private readonly settings: AdminSettingsService,
  ) {}

  previewBroadcast(dto: BroadcastInputDto) { return this.broadcasts.preview(dto); }
  createBroadcast(dto: BroadcastInputDto) { return this.broadcasts.create(dto); }
  getBroadcasts(query: BroadcastListQuery) { return this.broadcasts.list(query); }
  getBroadcastById(id: string, query: BroadcastDetailQuery) { return this.broadcasts.detail(id, query); }
  cancelBroadcast(id: string) { return this.broadcasts.cancel(id); }
  getDashboardStats() { return this.dashboard.getDashboardStats(); }
  getAnalytics(days: AnalyticsDays) { return this.analytics.getAnalytics(days); }
  getTopicStats() { return this.dashboard.getTopicStats(); }
  getUsers(page: number, limit: number) { return this.users.getUsers(page, limit); }
  getSettings() { return this.settings.getSettings(); }
  updateProductSettings(dto: UpdateRuntimeSettingsDto) { return this.settings.updateProduct(dto); }
  updateInfrastructureSettings(dto: UpdateRuntimeSettingsDto) { return this.settings.updateInfrastructure(dto); }
  getUserById(id: string) { return this.users.getUserById(id); }
  updateUser(id: string, dto: UpdateUserDto) { return this.users.updateUser(id, dto); }
  resetUserProgress(id: string) { return this.users.resetUserProgress(id); }
  getPrompts(page: number, limit: number) { return this.prompts.getPrompts(page, limit); }
  getPromptById(id: string) { return this.prompts.getPromptById(id); }
  createPrompt(dto: CreatePromptDto) { return this.prompts.createPrompt(dto); }
  updatePrompt(id: string, dto: UpdatePromptDto) { return this.prompts.updatePrompt(id, dto); }
  deletePrompt(id: string) { return this.prompts.deletePrompt(id); }
  getSessions(query: AdminSessionsQuery) { return this.sessions.getSessions(query); }
  getSessionById(id: string) { return this.sessions.getSessionById(id); }
  getAuditLogs(query: AdminAuditLogsQuery) { return this.audit.getLogs(query); }
  getAuditLogById(id: string) { return this.audit.getLogById(id); }
  getErrorLogs(page: number, limit: number, type?: AdminErrorType, service?: AdminErrorService, correlationId?: string) { return this.errorLogs.getErrorLogs(page, limit, type, service, correlationId); }
  getErrorLogById(id: string) { return this.errorLogs.getErrorLogById(id); }
  clearOldErrorLogs(daysOld = 30) { return this.errorLogs.clearOldErrorLogs(daysOld); }
}
