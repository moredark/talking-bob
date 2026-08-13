import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth";
import { AdminAnalyticsService } from "./admin-analytics.service";
import { AdminAuditContextService } from "./admin-audit-context.service";
import { AdminAuditInterceptor } from "./admin-audit.interceptor";
import { AdminAuditService } from "./admin-audit.service";
import { AdminController } from "./admin.controller";
import { AdminBroadcastsService } from "./admin-broadcasts.service";
import { BroadcastModule } from "../broadcast";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminErrorLogsService } from "./admin-error-logs.service";
import { AdminPromptsService } from "./admin-prompts.service";
import { AdminSessionsService } from "./admin-sessions.service";
import { AdminPersonalitiesService } from "./admin-personalities.service";
import { AdminSettingsService } from "./admin-settings.service";
import { AdminService } from "./admin.service";
import { AdminUsersService } from "./admin-users.service";

@Module({
  imports: [DatabaseModule, AuthModule, BroadcastModule],
  controllers: [AdminController],
  providers: [AdminAnalyticsService, AdminBroadcastsService, AdminAuditContextService, AdminAuditService, AdminAuditInterceptor, AdminDashboardService, AdminUsersService, AdminPromptsService, AdminSessionsService, AdminErrorLogsService, AdminSettingsService, AdminPersonalitiesService, AdminService],
  exports: [AdminService],
})
export class AdminModule {}
