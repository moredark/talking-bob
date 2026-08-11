import { ConflictException, Injectable, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, RuntimeSettings } from "@prisma/client";
import {
  RUNTIME_SETTINGS_REGISTRY,
  RuntimeSettingDefinition,
  RuntimeSettingValue,
  normalizeRuntimeOverride,
  validateRuntimeOverride,
} from "../../config/runtime-settings.registry";
import { RuntimeSettingsService } from "../../config/runtime-settings.service";
import {
  AdminReadonlySettingEntry,
  AdminRuntimeSettingEntry,
  AdminRuntimeSettingsGroup,
  AdminRuntimeSettingsResponse,
  AdminSecretSettingEntry,
  UpdateRuntimeSettingsDto,
} from "./admin.contracts";
import { AdminAuditService } from "./admin-audit.service";
import { AdminAuditContextService } from "./admin-audit-context.service";

const SAFE_READONLY_VALUES = new Set(["PORT", "LLM_API_URL", "ADMIN_CORS_ORIGIN", "ADMIN_PORT", "ADMIN_USERNAME"]);

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly settings: RuntimeSettingsService,
    private readonly audit: AdminAuditService,
    private readonly auditContext: AdminAuditContextService,
  ) {}

  async getSettings(): Promise<AdminRuntimeSettingsResponse> {
    try {
      return this.response(await this.settings.row());
    } catch {
      throw new ServiceUnavailableException("Runtime settings are unavailable");
    }
  }

  updateProduct(dto: UpdateRuntimeSettingsDto): Promise<AdminRuntimeSettingsGroup> {
    return this.update("product", dto);
  }

  updateInfrastructure(dto: UpdateRuntimeSettingsDto): Promise<AdminRuntimeSettingsGroup> {
    return this.update("infrastructure", dto);
  }

  private async update(
    group: "product" | "infrastructure",
    dto: UpdateRuntimeSettingsDto,
  ): Promise<AdminRuntimeSettingsGroup> {
    const action = group === "product" ? "settings.product.update" : "settings.infrastructure.update";
    const versionField = group === "product" ? "productVersion" : "infrastructureVersion";
    const overridesField = group === "product" ? "productOverrides" : "infrastructureOverrides";
    const changedKeys = Object.entries(dto.values).filter(([, value]) => value !== null).map(([key]) => key).sort();
    const resetKeys = Object.entries(dto.values).filter(([, value]) => value === null).map(([key]) => key).sort();

    let row: RuntimeSettings;
    try {
      row = await this.audit.runSuccess(
        { action, entityType: "runtime_settings" },
        async (tx) => {
          const current = await tx.runtimeSettings.findUnique({ where: { id: "singleton" } });
          if (!current) throw new ServiceUnavailableException("Runtime settings are unavailable");
          if (current[versionField] !== dto.expectedVersion) {
            throw new ConflictException("Runtime settings version conflict");
          }
          const overrides = group === "product"
            ? this.settings.productOverrides(current)
            : this.settings.infrastructureOverrides(current);
          const previousOverrideKeys = Object.keys(overrides).sort();
          for (const [key, value] of Object.entries(dto.values)) {
            const entry = RUNTIME_SETTINGS_REGISTRY.find((candidate) => candidate.key === key);
            if (!entry || entry.group !== group) throw new UnprocessableEntityException(`${key} is not an allowed ${group} setting`);
            if (value === null) delete overrides[key];
            else if (!validateRuntimeOverride(entry, value)) throw new UnprocessableEntityException(`${key} has an invalid value`);
            else overrides[key] = normalizeRuntimeOverride(entry, value);
          }
          const updatedCount = await tx.runtimeSettings.updateMany({
            where: { id: "singleton", [versionField]: dto.expectedVersion },
            data: {
              [overridesField]: overrides as Prisma.InputJsonObject,
              [versionField]: { increment: 1 },
              updatedAt: new Date(),
              updatedById: this.auditContext.current()?.actorId ?? this.auditContext.fallback().actorId,
              updatedByUsername: this.auditContext.current()?.actorUsername ?? this.auditContext.fallback().actorUsername,
            },
          });
          if (updatedCount.count !== 1) throw new ConflictException("Runtime settings version conflict");
          const updated = await tx.runtimeSettings.findUnique({ where: { id: "singleton" } });
          if (!updated) throw new ServiceUnavailableException("Runtime settings are unavailable");
          return {
            result: updated,
            entityId: "singleton",
            before: { version: dto.expectedVersion, overrideKeys: previousOverrideKeys },
            after: { version: dto.expectedVersion + 1, changedKeys, resetKeys, overrideKeys: Object.keys(overrides).sort() },
          };
        },
      );
    } catch (error) {
      if (error instanceof ConflictException || error instanceof UnprocessableEntityException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Runtime settings are unavailable");
    }
    if (group === "product") this.settings.refreshProduct(row);
    return this.group(group, row);
  }

  private response(row: RuntimeSettings): AdminRuntimeSettingsResponse {
    return {
      product: this.group("product", row),
      infrastructure: this.group("infrastructure", row),
      readonly: this.readonly(),
      secret: this.secret(),
    };
  }

  private group(group: "product" | "infrastructure", row: RuntimeSettings): AdminRuntimeSettingsGroup {
    const overrides = group === "product"
      ? this.settings.productOverrides(row)
      : this.settings.infrastructureOverrides(row);
    const entries = RUNTIME_SETTINGS_REGISTRY
      .filter((entry) => entry.group === group)
      .map((entry) => this.entry(group, entry, overrides));
    return {
      version: group === "product" ? row.productVersion : row.infrastructureVersion,
      applyMode: group === "product" ? "hot" : "restart",
      restartRequired: entries.some((entry) => entry.restartRequired),
      entries,
    };
  }

  private entry(
    group: "product" | "infrastructure",
    definition: RuntimeSettingDefinition,
    overrides: Record<string, RuntimeSettingValue>,
  ): AdminRuntimeSettingEntry {
    const envValue = this.settings.envValue(definition);
    const fallback = this.settings.envOrDefault(definition);
    const pendingValue = overrides[definition.key] ?? fallback;
    const effectiveValue = group === "product"
      ? pendingValue
      : this.settings.bootValue(definition);
    const currentSource = group === "product"
      ? (overrides[definition.key] !== undefined ? "override" : envValue !== null ? "env" : "default")
      : (this.settings.bootHasOverride(definition.key) ? "override" : envValue !== null ? "env" : "default");
    return {
      key: definition.key,
      description: definition.description,
      consumer: definition.consumer,
      type: definition.type,
      ...(definition.min === undefined ? {} : { min: definition.min }),
      ...(definition.max === undefined ? {} : { max: definition.max }),
      envValue,
      overrideValue: overrides[definition.key] ?? null,
      effectiveValue,
      pendingValue,
      source: currentSource,
      applyMode: group === "product" ? "hot" : "restart",
      restartRequired: group === "infrastructure" && pendingValue !== effectiveValue,
    };
  }

  private readonly(): AdminReadonlySettingEntry[] {
    return RUNTIME_SETTINGS_REGISTRY.filter((entry) => entry.group === "readonly").map((entry) => {
      const raw = this.settings.rawEnv(entry.key);
      const source = raw === undefined ? "default" as const : "env" as const;
      if (!SAFE_READONLY_VALUES.has(entry.key)) {
        return { key: entry.key, description: entry.description, consumer: entry.consumer, configured: Boolean(raw?.trim()), source, applyMode: "readonly" };
      }
      const value = raw === undefined ? null : entry.type === "integer" ? Number(raw) : raw.trim();
      return { key: entry.key, description: entry.description, consumer: entry.consumer, value, source, applyMode: "readonly" };
    });
  }

  private secret(): AdminSecretSettingEntry[] {
    return RUNTIME_SETTINGS_REGISTRY
      .filter((entry) => entry.group === "secret")
      .map((entry) => ({ key: entry.key, description: entry.description, configured: this.settings.isConfigured(entry.key) }));
  }
}
