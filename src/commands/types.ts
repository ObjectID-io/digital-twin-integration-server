export type CommandStatus = "authorized" | "dispatched" | "accepted" | "executing" | "succeeded" | "failed" | "rejected" | "expired" | "cancelled";

export interface CommandDefinition {
  name: string;
  version: string;
  description?: string;
  riskClass: "informational" | "operational" | "safety-relevant";
  timeoutSeconds: number;
  cancellable?: boolean;
  allowedRoles?: string[];
  parametersSchema: Record<string, unknown>;
}

export interface CommandCatalog {
  twinId: string;
  interfaceId: string;
  commands: CommandDefinition[];
}

export interface CommandRecord {
  specVersion: "objectid.command.v1";
  commandId: string;
  twinId: string;
  interfaceId: string;
  command: { name: string; version: string; parameters: Record<string, unknown> };
  requestedBy: { did: string };
  proof?: { type: "IotaPersonalMessage"; signature: string; canonicalization: "RFC8785" };
  requestedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  correlationId?: string;
  status: CommandStatus;
  statusUpdatedAt: string;
  transport: { type: "mqtt"; requestTopic: string; resultTopic: string; qos: 1 };
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface CommandConfig {
  enabled: boolean;
  storeFile: string;
  requestTopicTemplate: string;
  resultTopic: string;
  catalogs: CommandCatalog[];
}
