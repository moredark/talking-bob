import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { PrismaService } from "../../infrastructure/database";

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
  private readonly jwtSecret: string;

  constructor(private readonly prisma: PrismaService) {
    this.jwtSecret = process.env.JWT_SECRET || "default-secret-change-me";
  }

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

    const accessToken = jwt.sign(payload, this.jwtSecret, {
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
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;
      return payload;
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
