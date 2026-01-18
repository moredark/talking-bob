import { Injectable } from "@nestjs/common";
import { User } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database";

export interface CreateUserData {
  telegramId: bigint;
  username?: string;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId },
    });
  }

  async createUser(data: CreateUserData): Promise<User> {
    return this.prisma.user.create({
      data: {
        telegramId: data.telegramId,
        username: data.username,
      },
    });
  }

  async findOrCreateByTelegramId(
    telegramId: bigint,
    username?: string
  ): Promise<User> {
    const existingUser = await this.findByTelegramId(telegramId);

    if (existingUser) {
      return existingUser;
    }

    return this.createUser({ telegramId, username });
  }
}
