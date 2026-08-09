import { AppError } from "../common/errors.js";

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private readonly threshold = 3, private readonly resetMs = 30_000) {}
  async execute<T>(operation: () => Promise<T>) {
    if (this.openedAt && Date.now() - this.openedAt < this.resetMs) {
      throw new AppError("CONNECTOR_CIRCUIT_OPEN", "Connector circuit breaker is open", 503, "CONNECTOR");
    }
    try {
      const result = await operation();
      this.failures = 0; this.openedAt = 0;
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= this.threshold) this.openedAt = Date.now();
      throw error;
    }
  }
}
