import type { MappedMqttMessage } from "../twin/mqttMapping.js";
import { positionFromPayload, type TwinPosition } from "./position.js";

export interface RealtimeEncryptionMetadata {
  encrypted: boolean;
  algorithm?: string;
  keyId?: string;
  version?: number;
}

export interface TwinRealtimeEvent {
  twinId: string;
  source: { type: "mqtt" | "opcua"; address: string };
  observedAt: number;
  receivedAt: number;
  payload: unknown;
  position?: TwinPosition;
  encryption: RealtimeEncryptionMetadata;
}

type Subscriber = (event: TwinRealtimeEvent) => void;

export class TwinRealtimeHub {
  private readonly latestEvents = new Map<string, TwinRealtimeEvent>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  publish(message: MappedMqttMessage): TwinRealtimeEvent {
    const twinId = String(message.mapping.twinId ?? "").trim();
    if (!twinId) throw new Error("Realtime messages require a mapped Twin ID");
    const source = message.nodeId
      ? { type: "opcua" as const, address: message.nodeId }
      : { type: "mqtt" as const, address: message.topic ?? "unknown" };
    const event: TwinRealtimeEvent = {
      twinId,
      source,
      observedAt: message.observedAt,
      receivedAt: Date.now(),
      payload: message.value,
      position: positionFromPayload(message.value, message.observedAt),
      encryption: encryptionMetadata(message.value),
    };
    this.latestEvents.set(twinId, event);
    for (const subscriber of this.subscribers.get(twinId) ?? []) subscriber(event);
    return event;
  }

  latest(twinId: string) { return this.latestEvents.get(twinId); }

  subscribe(twinId: string, subscriber: Subscriber) {
    const current = this.subscribers.get(twinId) ?? new Set<Subscriber>();
    current.add(subscriber);
    this.subscribers.set(twinId, current);
    return () => {
      current.delete(subscriber);
      if (!current.size) this.subscribers.delete(twinId);
    };
  }

  subscriberCount(twinId: string) { return this.subscribers.get(twinId)?.size ?? 0; }
}

function encryptionMetadata(value: unknown): RealtimeEncryptionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { encrypted: false };
  const envelope = value as Record<string, unknown>;
  if (envelope.encrypted !== true || typeof envelope.ciphertext !== "string") return { encrypted: false };
  return {
    encrypted: true,
    algorithm: typeof envelope.algorithm === "string" ? envelope.algorithm : undefined,
    keyId: typeof envelope.keyId === "string" ? envelope.keyId : undefined,
    version: Number.isFinite(Number(envelope.version)) ? Number(envelope.version) : undefined,
  };
}
