import "dotenv/config";
import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import {
  parseRuntimeConfig,
  RuntimeConfigError,
} from "./config/runtime.config";

async function bootstrap() {
  const runtimeConfig = parseRuntimeConfig(process.env);
  let app: INestApplication | undefined;

  try {
    app = await NestFactory.create(AppModule.forRoot(runtimeConfig));
    app.enableShutdownHooks();

    app.enableCors({
      origin: process.env.ADMIN_CORS_ORIGIN || "http://localhost:5173",
      credentials: true,
    });

    const port = runtimeConfig.server.port;
    await app.listen(port);

    console.log(`Talking Bob bot is running on port ${port}...`);
  } catch (error) {
    await app?.close().catch(() => undefined);
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  const detail =
    error instanceof RuntimeConfigError
      ? error.message
      : error instanceof Error
        ? error.name
        : "Unknown startup error";
  console.error(`Talking Bob startup failed: ${detail}`);
  process.exitCode = 1;
});
