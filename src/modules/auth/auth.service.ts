import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { RUNTIME_CONFIG } from "../../config/runtime-config.module";
import { RuntimeConfig } from "../../config/runtime.config";
import { PrismaService } from "../../infrastructure/database";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


export interface JwtPayload {
  sub: string;
  username: string;
}

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
  };
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async login(username: string, password: string): Promise<LoginResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
    });

    if (!admin) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await bcrypt.compare(password, admin.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const payload: JwtPayload = {
      sub: admin.id,
      username: admin.username,
    };

    const accessToken = jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: "7d",
    });

    return {
      accessToken,
      user: {
        id: admin.id,
        username: admin.username,
      },
    };
  }

  async validateToken(token: string): Promise<JwtPayload> {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret);
      if (
        payload === null || typeof payload !== "object"
        || typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)
        || typeof payload.username !== "string"
        || payload.username.trim().length < 1 || payload.username.length > 200
        || /[\u0000-\u001f\u007f]/.test(payload.username)
      ) {
        throw new Error("Invalid token claims");
      }
      return { sub: payload.sub, username: payload.username.trim() };
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }

  async getAdminById(id: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, username: true, createdAt: true },
    });

    if (!admin) {
      throw new UnauthorizedException("Admin not found");
    }

    return admin;
  }

  async createAdmin(username: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 10);

    return this.prisma.adminUser.create({
      data: {
        username,
        passwordHash,
      },
      select: { id: true, username: true, createdAt: true },
    });
  }
}
