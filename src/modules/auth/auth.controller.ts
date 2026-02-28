import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
} from "@nestjs/common";
import { AuthService, JwtPayload } from "./auth.service";
import { AuthGuard } from "./auth.guard";

interface LoginDto {
  username: string;
  password: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }

  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Request() req: { admin: JwtPayload }) {
    return this.authService.getAdminById(req.admin.sub);
  }
}
