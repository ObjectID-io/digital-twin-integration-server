import { createHash } from "node:crypto";
import { AppError } from "../common/errors.js";
import type { MqttMapping } from "../connectors/mqtt.js";
import type { OpcUaMapping } from "../connectors/opcua.js";

export interface MappedMqttMessage { mapping: MqttMapping | OpcUaMapping; topic?: string; nodeId?: string; value: unknown; observedAt: number }

export function mqttMessageToState(message: MappedMqttMessage) {
  if ((message.mapping.mode ?? "state") !== "state") throw new AppError("MQTT_MAPPING_MODE_INVALID", "Dataset mappings cannot be converted to state", 422, "CONNECTOR");
  if (!message.mapping.twinId || !message.mapping.aspect || !message.mapping.sampleType) {
    throw new AppError("MQTT_MAPPING_INVALID", "MQTT mapping requires twinId, aspect and sampleType", 422, "CONNECTOR");
  }
  const serializedPayload = JSON.stringify(message.value);
  return {
    twinId: message.mapping.twinId,
    state: {
      aspectCode: message.mapping.aspect,
      sampleType: message.mapping.sampleType,
      sourceUri: publicConnectorUri(message),
      payloadHash: createHash("sha256").update(serializedPayload).digest("hex"),
      payloadInline: "",
      observedAt: message.observedAt,
    },
  };
}

export function mqttMessageToDataset(message: MappedMqttMessage) {
  if (message.mapping.mode !== "dataset" || !message.mapping.twinId || !message.mapping.datasetType) {
    throw new AppError("MQTT_DATASET_MAPPING_INVALID", "Dataset mapping requires twinId and datasetType", 422, "CONNECTOR");
  }
  return {
    key: `${message.mapping.twinId}:${"topic" in message.mapping ? message.mapping.topic : message.mapping.nodeId}`,
    twinId: message.mapping.twinId,
    value: message.value,
    observedAt: message.observedAt,
    windowMs: message.mapping.windowSeconds ? message.mapping.windowSeconds * 1_000 : undefined,
    metadata: {
      twinId: message.mapping.twinId,
      source: sourceUri(message),
      datasetType: message.mapping.datasetType,
      schemaUri: message.mapping.schemaUri,
      profile: message.mapping.profile,
      tenantId: message.mapping.tenantId,
    },
  };
}

function sourceUri(message: MappedMqttMessage) {
  return message.nodeId ? `opcua://${message.nodeId}` : `mqtt://${message.topic ?? "unknown"}`;
}

function publicConnectorUri(message: MappedMqttMessage) {
  return message.nodeId ? "objectid-connector://opcua" : "objectid-connector://mqtt";
}
