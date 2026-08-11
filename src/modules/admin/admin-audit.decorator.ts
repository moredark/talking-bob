import { SetMetadata } from "@nestjs/common";
import { AdminAuditAction, AdminAuditEntityType } from "./admin.contracts";

export const ADMIN_AUDIT_MUTATION_METADATA = "admin:audit-mutation";

export interface AdminAuditMutationMetadata {
  action: AdminAuditAction;
  entityType: AdminAuditEntityType;
}

export function AdminAuditMutation(
  action: AdminAuditAction,
  entityType: AdminAuditEntityType,
): MethodDecorator {
  return SetMetadata(ADMIN_AUDIT_MUTATION_METADATA, { action, entityType });
}
