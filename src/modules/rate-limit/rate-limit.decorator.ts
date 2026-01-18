import { SetMetadata } from "@nestjs/common";
import { RateLimitConfig } from "./rate-limit.service";

export const RATE_LIMIT_KEY = "rateLimit";

export interface RateLimitOptions {
  action: string;
  config?: RateLimitConfig;
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
