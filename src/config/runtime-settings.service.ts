import { Inject, Injectable, InjectionToken } from "@nestjs/common";
import { Prisma, PrismaClient, RuntimeSettings } from "@prisma/client";
import { PrismaService } from "../infrastructure/database";
import {
  normalizeRuntimeOverride,
  registryEntry,
  RUNTIME_SETTINGS_REGISTRY,
  RuntimeSettingDefinition,
  RuntimeSettingValue,
  validateRuntimeOverride,
} from "./runtime-settings.registry";
import { RuntimeConfig } from "./runtime.config";

export const RUNTIME_SETTINGS_BOOTSTRAP: InjectionToken = Symbol("RUNTIME_SETTINGS_BOOTSTRAP");
export const RUNTIME_SETTINGS_ID = "singleton";

type OverrideMap = Record<string, RuntimeSettingValue>;

export interface RuntimeSettingsBootstrap {
  row: RuntimeSettings;
  env: Readonly<Record<string, string | undefined>>;
  bootInfrastructure: Readonly<OverrideMap>;
}

function objectValue(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validOverrides(group: "product" | "infrastructure", value: Prisma.JsonValue): OverrideMap {
  const allowed = new Set(RUNTIME_SETTINGS_REGISTRY.filter((item) => item.group === group).map((item) => item.key));
  const source = objectValue(value);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      const safeKey = /^[A-Z0-9_]{1,80}$/.test(key) ? key : "unknown";
      console.error(`Ignoring unknown persisted runtime setting: ${safeKey}`);
    }
  }
  const result: OverrideMap = {};
  for (const entry of RUNTIME_SETTINGS_REGISTRY.filter((item) => item.group === group)) {
    if (!(entry.key in source)) continue;
    const candidate = source[entry.key];
    if (validateRuntimeOverride(entry, candidate)) {
      result[entry.key] = normalizeRuntimeOverride(entry, candidate);
    } else {
      console.error(`Ignoring invalid persisted runtime setting: ${entry.key}`);
    }
  }
  return result;
}

export async function loadRuntimeSettingsBootstrap(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  client?: PrismaClient,
): Promise<RuntimeSettingsBootstrap> {
  const prisma = client ?? new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await prisma.$connect();
    const row = await prisma.runtimeSettings.findUnique({ where: { id: RUNTIME_SETTINGS_ID } });
    if (!row) throw new Error("Runtime settings singleton is missing");
    const productOverrides = validOverrides("product", row.productOverrides);
    const infrastructureOverrides = validOverrides("infrastructure", row.infrastructureOverrides);
    return {
      row: { ...row, productOverrides, infrastructureOverrides },
      env: Object.freeze(Object.fromEntries(RUNTIME_SETTINGS_REGISTRY.map((entry) => [entry.key, env[entry.envKey ?? ""]]))),
      bootInfrastructure: Object.freeze(infrastructureOverrides),
    };
  } finally {
    await prisma.$disconnect();
  }
}

export function applyBootInfrastructure(config: RuntimeConfig, values: Readonly<OverrideMap>): RuntimeConfig {
  return {
    ...config,
    telegram: { apiTimeoutMs: numberValue(values, "TELEGRAM_API_TIMEOUT_MS", config.telegram.apiTimeoutMs) },
    llm: {
      ...config.llm,
      model: stringValue(values, "LLM_MODEL", config.llm.model),
    },
    concurrency: {
      telegramUpdates: numberValue(values, "TELEGRAM_UPDATE_CONCURRENCY", config.concurrency.telegramUpdates),
      aiRequests: numberValue(values, "AI_REQUEST_CONCURRENCY", config.concurrency.aiRequests),
      aiRequestMaxPending: numberValue(values, "AI_REQUEST_MAX_PENDING", config.concurrency.aiRequestMaxPending),
    },
    shutdown: { drainTimeoutMs: numberValue(values, "RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS", config.shutdown.drainTimeoutMs) },
    externalRequests: {
      telegramFileDownload: {
        timeoutMs: numberValue(values, "TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS", config.externalRequests.telegramFileDownload.timeoutMs),
        maxResponseBytes: numberValue(values, "TELEGRAM_FILE_DOWNLOAD_MAX_RESPONSE_BYTES", config.externalRequests.telegramFileDownload.maxResponseBytes),
      },
      whisper: {
        timeoutMs: numberValue(values, "WHISPER_REQUEST_TIMEOUT_MS", config.externalRequests.whisper.timeoutMs),
        maxResponseBytes: numberValue(values, "WHISPER_REQUEST_MAX_RESPONSE_BYTES", config.externalRequests.whisper.maxResponseBytes),
      },
      llm: {
        timeoutMs: numberValue(values, "LLM_REQUEST_TIMEOUT_MS", config.externalRequests.llm.timeoutMs),
        maxResponseBytes: numberValue(values, "LLM_REQUEST_MAX_RESPONSE_BYTES", config.externalRequests.llm.maxResponseBytes),
      },
    },
  };
}

function numberValue(values: Readonly<OverrideMap>, key: string, fallback: number): number {
  return typeof values[key] === "number" ? values[key] as number : fallback;
}

function stringValue(values: Readonly<OverrideMap>, key: string, fallback: string): string {
  return typeof values[key] === "string" ? values[key] as string : fallback;
}

@Injectable()
export class RuntimeSettingsService {
  private productSnapshot: Readonly<OverrideMap>;
  private productSnapshotVersion: number;

  private productVersion: number;
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUNTIME_SETTINGS_BOOTSTRAP) private readonly bootstrap: RuntimeSettingsBootstrap,
  ) {
    this.productSnapshot = Object.freeze(validOverrides("product", bootstrap.row.productOverrides));
    this.productSnapshotVersion = bootstrap.row.productVersion;
    this.productVersion = bootstrap.row.productVersion;
  }

  productNumber(key: string): number {
    const entry = registryEntry(key);
    if (!entry || entry.group !== "product" || entry.type !== "integer") throw new Error("Unknown product setting");
    const value = this.productSnapshot[key] ?? this.envOrDefault(entry);
    return value as number;
  }

  async row(): Promise<RuntimeSettings> {
    const row = await this.prisma.runtimeSettings.findUnique({ where: { id: RUNTIME_SETTINGS_ID } });
    if (!row) throw new Error("Runtime settings singleton is missing");
    return row;
  }

  refreshProduct(row: RuntimeSettings): void {
    if (row.productVersion < this.productVersion) return;
    this.productSnapshot = Object.freeze(validOverrides("product", row.productOverrides));
    this.productVersion = row.productVersion;
  }

  productOverrides(row: RuntimeSettings): OverrideMap {
    return validOverrides("product", row.productOverrides);
  }

  infrastructureOverrides(row: RuntimeSettings): OverrideMap {
    return validOverrides("infrastructure", row.infrastructureOverrides);
  }

  envOrDefault(entry: RuntimeSettingDefinition): RuntimeSettingValue {
    const raw = entry.envKey ? this.bootstrap.env[entry.envKey] : undefined;
    if (raw !== undefined) {
      const candidate: unknown = entry.type === "integer" ? Number(raw) : raw;
      if (validateRuntimeOverride(entry, candidate)) return normalizeRuntimeOverride(entry, candidate);
    }
    if (entry.defaultValue === undefined) throw new Error(`No default for ${entry.key}`);
    return entry.defaultValue;
  }

  bootValue(entry: RuntimeSettingDefinition): RuntimeSettingValue {
    return this.bootstrap.bootInfrastructure[entry.key] ?? this.envOrDefault(entry);
  }

  bootHasOverride(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.bootstrap.bootInfrastructure, key);
  }

  rawEnv(key: string): string | undefined {
    return this.bootstrap.env[key];
  }

  currentProductSnapshot(): Readonly<OverrideMap> {
    return this.productSnapshot;
  }

  envValue(entry: RuntimeSettingDefinition): RuntimeSettingValue | null {
    if (!entry.envKey || this.bootstrap.env[entry.envKey] === undefined) return null;
    const raw = this.bootstrap.env[entry.envKey];
    const candidate: unknown = entry.type === "integer" ? Number(raw) : raw;
    return validateRuntimeOverride(entry, candidate) ? normalizeRuntimeOverride(entry, candidate) : null;
  }

  isConfigured(key: string): boolean {
    return Boolean(this.bootstrap.env[key]?.trim());
  }
}
