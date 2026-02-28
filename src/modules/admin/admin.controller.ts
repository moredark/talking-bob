import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  NotFoundException,
} from "@nestjs/common";
import {
  AdminService,
  CreatePromptDto,
  UpdatePromptDto,
  UpdateUserDto,
} from "./admin.service";
import { AuthGuard } from "../auth";
import { ErrorType, ErrorService } from "../error-log";

@Controller("admin")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("dashboard")
  async getDashboard() {
    return this.adminService.getDashboardStats();
  }

  @Get("users")
  async getUsers(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const pageNum = parseInt(page || "1", 10);
    const limitNum = parseInt(limit || "20", 10);

    return this.adminService.getUsers(pageNum, limitNum);
  }

  @Get("users/:id")
  async getUserById(@Param("id") id: string) {
    const user = await this.adminService.getUserById(id);

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  }

  @Get("topics")
  async getTopics() {
    return this.adminService.getTopicStats();
  }

  // ============ PROMPTS CRUD ============

  @Get("prompts")
  async getPrompts(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const pageNum = parseInt(page || "1", 10);
    const limitNum = parseInt(limit || "20", 10);

    return this.adminService.getPrompts(pageNum, limitNum);
  }

  @Get("prompts/:id")
  async getPromptById(@Param("id") id: string) {
    const prompt = await this.adminService.getPromptById(id);

    if (!prompt) {
      throw new NotFoundException("Prompt not found");
    }

    return prompt;
  }

  @Post("prompts")
  async createPrompt(@Body() dto: CreatePromptDto) {
    return this.adminService.createPrompt(dto);
  }

  @Patch("prompts/:id")
  async updatePrompt(@Param("id") id: string, @Body() dto: UpdatePromptDto) {
    const prompt = await this.adminService.updatePrompt(id, dto);

    if (!prompt) {
      throw new NotFoundException("Prompt not found");
    }

    return prompt;
  }

  @Delete("prompts/:id")
  async deletePrompt(@Param("id") id: string) {
    const deleted = await this.adminService.deletePrompt(id);

    if (!deleted) {
      throw new NotFoundException("Prompt not found");
    }

    return { success: true };
  }

  // ============ USER ACTIONS ============

  @Patch("users/:id")
  async updateUser(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    const user = await this.adminService.updateUser(id, dto);

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  }

  @Post("users/:id/reset-progress")
  async resetUserProgress(@Param("id") id: string) {
    const result = await this.adminService.resetUserProgress(id);

    if (!result) {
      throw new NotFoundException("User not found");
    }

    return { success: true };
  }

  // ============ ERROR LOGS ============

  @Get("error-logs")
  async getErrorLogs(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("type") type?: ErrorType,
    @Query("service") service?: ErrorService,
  ) {
    const pageNum = parseInt(page || "1", 10);
    const limitNum = parseInt(limit || "50", 10);

    return this.adminService.getErrorLogs(pageNum, limitNum, type, service);
  }

  @Get("error-logs/:id")
  async getErrorLogById(@Param("id") id: string) {
    const log = await this.adminService.getErrorLogById(id);

    if (!log) {
      throw new NotFoundException("Error log not found");
    }

    return log;
  }

  @Delete("error-logs/old")
  async clearOldErrorLogs(@Query("days") days?: string) {
    const daysOld = parseInt(days || "30", 10);
    const count = await this.adminService.clearOldErrorLogs(daysOld);

    return { deleted: count };
  }
}
