export interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  newUsersThisWeek: number;
  totalPromptsSent: number;
  totalResponses: number;
  responseRate: number;
  averageScore: number | null;
  usersWithDailyEnabled: number;
}

export interface UserListItem {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: string;
  dailyPromptEnabled: boolean;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  lastActivityAt: string | null;
}

export interface UserDetail {
  id: string;
  telegramId: string;
  username: string | null;
  createdAt: string;
  dailyPromptEnabled: boolean;
  dailyPromptHour: number;
  dailyPromptMinute: number;
  timezone: string;
  languageLevel: string | null;
  status: string;
  bannedAt: string | null;
  bannedReason: string | null;
  promptsReceived: number;
  responsesCount: number;
  averageScore: number | null;
  responses: UserResponse[];
}

export interface UserResponse {
  id: string;
  promptTopic: string;
  transcript: string | null;
  overallScore: number | null;
  createdAt: string;
}

export interface TopicStats {
  id: string;
  topic: string;
  isActive: boolean;
  timesSent: number;
  responsesCount: number;
  responseRate: number;
  averageScore: number | null;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
  };
}

export interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface PromptItem {
  id: string;
  topic: string;
  textContent: string | null;
  audioFileId: string;
  difficulty: string;
  tags: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  timesSent: number;
}

export interface CreatePromptDto {
  topic: string;
  textContent?: string;
  audioFileId: string;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdatePromptDto {
  topic?: string;
  textContent?: string;
  audioFileId?: string;
  difficulty?: string;
  tags?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateUserDto {
  dailyPromptEnabled?: boolean;
  languageLevel?: string | null;
  status?: string;
  bannedReason?: string;
}

export interface ErrorLogItem {
  id: string;
  type: string;
  service: string;
  message: string;
  stack: string | null;
  metadata: unknown;
  userId: string | null;
  createdAt: string;
}
