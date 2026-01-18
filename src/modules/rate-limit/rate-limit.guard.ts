import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitService } from "./rate-limit.service";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./rate-limit.decorator";

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!options) {
      return true;
    }

    const userId = this.extractUserId(context);
    if (!userId) {
      return true;
    }

    const isAllowed = await this.rateLimitService.checkLimit(
      userId,
      options.action,
      options.config
    );

    if (!isAllowed) {
      throw new HttpException(
        "Rate limit exceeded",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    await this.rateLimitService.recordAction(userId, options.action);
    return true;
  }

  private extractUserId(context: ExecutionContext): string | null {
    const request = context.switchToHttp().getRequest();
    return request?.user?.id ?? request?.userId ?? null;
  }
}
