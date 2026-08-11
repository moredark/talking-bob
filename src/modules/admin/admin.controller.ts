import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { AuthGuard } from "../auth";
import { AdminAuditLogsQuery, AdminSessionsQuery, AnalyticsDays, BroadcastDetailQuery, BroadcastInputDto, BroadcastListQuery, CreatePromptDto, ErrorLogsQuery, PaginationQuery, UpdatePromptDto, UpdateRuntimeSettingsDto, UpdateUserDto } from "./admin.contracts";
import { AdminBroadcastDetailQueryPipe, AdminBroadcastInputPipe, AdminBroadcastListQueryPipe } from "./admin-broadcast-validation.pipe";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminAuditMutation } from "./admin-audit.decorator";
import { AdminExceptionFilter } from "./admin-exception.filter";
import { AdminService } from "./admin.service";
import { AdminAnalyticsQueryPipe, AdminAuditLogsQueryPipe, AdminCreatePromptPipe, AdminDaysPipe, AdminErrorLogsQueryPipe, AdminPaginationPipe, AdminRuntimeSettingsPatchPipe, AdminSessionsQueryPipe, AdminUpdatePromptPipe, AdminUpdateUserPipe, AdminUuidPipe } from "./admin-validation.pipe";

@Controller("admin")
@UseGuards(AuthGuard)
@UseFilters(AdminExceptionFilter)
@UseInterceptors(AdminAuditInterceptor)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("dashboard")
  getDashboard() { return this.adminService.getDashboardStats(); }
  @Get("analytics")
  getAnalytics(@Query(AdminAnalyticsQueryPipe) days: AnalyticsDays) {
    return this.adminService.getAnalytics(days);
  }

  @Get("settings")
  getSettings() { return this.adminService.getSettings(); }

  @Patch("settings/product")
  @AdminAuditMutation("settings.product.update", "runtime_settings")
  updateProductSettings(@Body(new AdminRuntimeSettingsPatchPipe("product")) dto: UpdateRuntimeSettingsDto) {
    return this.adminService.updateProductSettings(dto);
  }

  @Patch("settings/infrastructure")
  @AdminAuditMutation("settings.infrastructure.update", "runtime_settings")
  updateInfrastructureSettings(@Body(new AdminRuntimeSettingsPatchPipe("infrastructure")) dto: UpdateRuntimeSettingsDto) {
    return this.adminService.updateInfrastructureSettings(dto);
  }

  @Post("broadcasts/preview")
  previewBroadcast(@Body(new AdminBroadcastInputPipe()) dto: BroadcastInputDto) {
    return this.adminService.previewBroadcast(dto);
  }

  @Post("broadcasts")
  @AdminAuditMutation("broadcast.create", "broadcast")
  createBroadcast(@Body(new AdminBroadcastInputPipe()) dto: BroadcastInputDto) {
    return this.adminService.createBroadcast(dto);
  }

  @Get("broadcasts")
  getBroadcasts(@Query(AdminBroadcastListQueryPipe) query: BroadcastListQuery) {
    return this.adminService.getBroadcasts(query);
  }

  @Get("broadcasts/:id")
  async getBroadcastById(
    @Param("id", AdminUuidPipe) id: string,
    @Query(AdminBroadcastDetailQueryPipe) query: BroadcastDetailQuery,
  ) {
    const broadcast = await this.adminService.getBroadcastById(id, query);
    if (!broadcast) throw new NotFoundException("Broadcast not found");
    return broadcast;
  }

  @Post("broadcasts/:id/cancel")
  @AdminAuditMutation("broadcast.cancel", "broadcast")
  cancelBroadcast(@Param("id", AdminUuidPipe) id: string) {
    return this.adminService.cancelBroadcast(id);
  }


  @Get("users")
  getUsers(@Query(new AdminPaginationPipe(20)) query: PaginationQuery) {
    return this.adminService.getUsers(query.page, query.limit);
  }

  @Get("users/:id")
  async getUserById(@Param("id", AdminUuidPipe) id: string) {
    const user = await this.adminService.getUserById(id);
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  @Get("topics")
  getTopics() { return this.adminService.getTopicStats(); }

  @Get("prompts")
  getPrompts(@Query(new AdminPaginationPipe(20)) query: PaginationQuery) {
    return this.adminService.getPrompts(query.page, query.limit);
  }

  @Get("prompts/:id")
  async getPromptById(@Param("id", AdminUuidPipe) id: string) {
    const prompt = await this.adminService.getPromptById(id);
    if (!prompt) throw new NotFoundException("Prompt not found");
    return prompt;
  }

  @Post("prompts")
  @AdminAuditMutation("prompt.create", "prompt")
  createPrompt(@Body(AdminCreatePromptPipe) dto: CreatePromptDto) {
    return this.adminService.createPrompt(dto);
  }

  @Patch("prompts/:id")
  @AdminAuditMutation("prompt.update", "prompt")
  async updatePrompt(@Param("id", AdminUuidPipe) id: string, @Body(AdminUpdatePromptPipe) dto: UpdatePromptDto) {
    const prompt = await this.adminService.updatePrompt(id, dto);
    if (!prompt) throw new NotFoundException("Prompt not found");
    return prompt;
  }

  @Delete("prompts/:id")
  @AdminAuditMutation("prompt.delete", "prompt")
  async deletePrompt(@Param("id", AdminUuidPipe) id: string) {
    if (!await this.adminService.deletePrompt(id)) throw new NotFoundException("Prompt not found");
    return { success: true };
  }

  @Patch("users/:id")
  @AdminAuditMutation("user.update", "user")
  async updateUser(@Param("id", AdminUuidPipe) id: string, @Body(AdminUpdateUserPipe) dto: UpdateUserDto) {
    const user = await this.adminService.updateUser(id, dto);
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  @Post("users/:id/reset-progress")
  @AdminAuditMutation("user.reset_progress", "user")
  async resetUserProgress(@Param("id", AdminUuidPipe) id: string) {
    if (!await this.adminService.resetUserProgress(id)) throw new NotFoundException("User not found");
    return { success: true };
  }

  @Get("sessions")
  getSessions(@Query(AdminSessionsQueryPipe) query: AdminSessionsQuery) {
    return this.adminService.getSessions(query);
  }

  @Get("sessions/:id")
  async getSessionById(@Param("id", AdminUuidPipe) id: string) {
    const session = await this.adminService.getSessionById(id);
    if (!session) throw new NotFoundException("Session not found");
    return session;
  }

  @Get("audit-logs")
  getAuditLogs(@Query(AdminAuditLogsQueryPipe) query: AdminAuditLogsQuery) {
    return this.adminService.getAuditLogs(query);
  }

  @Get("audit-logs/:id")
  async getAuditLogById(@Param("id", AdminUuidPipe) id: string) {
    const log = await this.adminService.getAuditLogById(id);
    if (!log) throw new NotFoundException("Audit log not found");
    return log;
  }

  @Get("error-logs")
  getErrorLogs(@Query(AdminErrorLogsQueryPipe) query: ErrorLogsQuery) {
    return this.adminService.getErrorLogs(query.page, query.limit, query.type, query.service, query.correlationId);
  }

  @Get("error-logs/:id")
  async getErrorLogById(@Param("id", AdminUuidPipe) id: string) {
    const log = await this.adminService.getErrorLogById(id);
    if (!log) throw new NotFoundException("Error log not found");
    return log;
  }

  @Delete("error-logs/old")
  @AdminAuditMutation("error_log.clear_old", "error_log")
  async clearOldErrorLogs(@Query("days", AdminDaysPipe) days: number) {
    return { deleted: await this.adminService.clearOldErrorLogs(days) };
  }
}
