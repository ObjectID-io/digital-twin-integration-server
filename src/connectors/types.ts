export interface HealthStatus { healthy: boolean; message?: string; checkedAt: string }
export interface Subscription { close(): Promise<void> }
export interface TwinConnector {
  readonly type: string;
  connect(config: Record<string, unknown>): Promise<void>;
  read(input: unknown): Promise<unknown>;
  write?(input: unknown): Promise<void>;
  subscribe?(handler: (data: unknown) => Promise<void> | void): Promise<Subscription>;
  subscribeTo?(topic: string, handler: (data: unknown) => Promise<void> | void, qos?: 0 | 1 | 2): Promise<Subscription>;
  healthCheck(): Promise<HealthStatus>;
  disconnect(): Promise<void>;
}
