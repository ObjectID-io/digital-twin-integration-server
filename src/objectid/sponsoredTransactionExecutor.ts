import type { IotaClient, IotaTransactionBlockResponse } from "@iota/iota-sdk/client";
import type { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import type { ObjectRef, Transaction } from "@iota/iota-sdk/transactions";
import { AppError } from "../common/errors.js";
import { logger } from "../common/logger.js";

export interface GasStationConnection {
  url: string;
  token: string;
  reserveDurationSeconds: number;
}

interface GasReservation {
  sponsor_address: string;
  reservation_id: number;
  gas_coins: ObjectRef[];
}

export class SponsoredTransactionExecutor {
  constructor(
    private readonly client: IotaClient,
    private readonly keypair: Ed25519Keypair,
    private readonly stations: GasStationConnection[],
    private readonly gasBudget: number,
    private readonly timeoutMs: number,
  ) {}

  async execute(buildTransaction: () => Transaction, operation: string): Promise<IotaTransactionBlockResponse> {
    let lastError: unknown;
    for (const [index, station] of this.stations.entries()) {
      try {
        return await this.executeAtStation(buildTransaction(), station, operation);
      } catch (error) {
        if (isDefinitiveOrAmbiguousSubmission(error)) throw error;
        lastError = error;
        logger.warn({ operation, stationIndex: index + 1, error: safeError(error) }, "gas_station_attempt_failed");
      }
    }
    throw new AppError(
      "OBJECTID_GAS_STATION_UNAVAILABLE",
      `All configured ObjectID Gas Stations rejected or failed operation '${operation}'`,
      503,
      "OBJECTID",
      { cause: safeError(lastError) },
    );
  }

  private async executeAtStation(tx: Transaction, station: GasStationConnection, operation: string) {
    const reservation = await this.post<GasReservation>(station, "/v1/reserve_gas", {
      gas_budget: this.gasBudget,
      reserve_duration_secs: station.reserveDurationSeconds,
    });
    validateReservation(reservation);

    tx.setSender(this.keypair.toIotaAddress());
    tx.setGasOwner(reservation.sponsor_address);
    tx.setGasPayment(reservation.gas_coins);
    tx.setGasBudget(this.gasBudget);
    const transactionBytes = await tx.build({ client: this.client });
    const { signature } = await this.keypair.signTransaction(transactionBytes);
    let execution: Record<string, any>;
    try {
      execution = await this.post<Record<string, any>>(station, "/v1/execute_tx", {
        reservation_id: reservation.reservation_id,
        tx_bytes: Buffer.from(transactionBytes).toString("base64"),
        user_sig: signature,
      });
    } catch (error) {
      const stationStatus = error instanceof AppError ? Number(error.details.stationStatus ?? 0) : 0;
      if (stationStatus >= 400 && stationStatus < 500) throw error;
      throw new AppError(
        "OBJECTID_SPONSORED_SUBMISSION_UNKNOWN",
        `Gas Station submission outcome is unknown for operation '${operation}'`,
        503,
        "NETWORK",
        { operation, retryable: false, submissionUnknown: true, cause: safeError(error) },
      );
    }
    const effects = execution.effects ?? execution.result?.effects ?? execution.result ?? execution;
    const digest = String(effects?.transactionDigest ?? effects?.transaction_digest ?? execution.digest ?? "");
    if (!digest) throw new AppError("OBJECTID_GAS_STATION_RESPONSE_INVALID", "Gas Station response has no transaction digest", 502, "OBJECTID");

    let result: IotaTransactionBlockResponse;
    try {
      result = await this.client.waitForTransaction({
        digest,
        timeout: this.timeoutMs,
        options: { showEffects: true, showEvents: true, showObjectChanges: true },
      });
    } catch (error) {
      throw new AppError(
        "OBJECTID_SPONSORED_CONFIRMATION_UNKNOWN",
        `Sponsored operation '${operation}' was submitted but could not be confirmed`,
        503,
        "NETWORK",
        { digest, operation, retryable: false, submissionUnknown: true, cause: safeError(error) },
      );
    }
    if (result.effects?.status.status !== "success") {
      throw new AppError(
        "OBJECTID_SPONSORED_TRANSACTION_FAILED",
        result.effects?.status.error ?? `Sponsored operation '${operation}' failed`,
        502,
        "OBJECTID",
        { digest, operation },
      );
    }
    logger.info({ digest, operation }, "iota_sponsored_transaction_executed");
    return result;
  }

  private async post<T>(station: GasStationConnection, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${station.url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${station.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => undefined) as any;
    if (!response.ok) {
      throw new AppError(
        "OBJECTID_GAS_STATION_REJECTED",
        String(payload?.error?.message ?? payload?.message ?? `Gas Station returned HTTP ${response.status}`),
        response.status >= 500 ? 503 : 502,
        "OBJECTID",
        { stationStatus: response.status },
      );
    }
    return (payload?.result ?? payload) as T;
  }
}

function validateReservation(value: GasReservation) {
  if (!value?.sponsor_address || !Number.isInteger(value.reservation_id) || !Array.isArray(value.gas_coins) || !value.gas_coins.length) {
    throw new AppError("OBJECTID_GAS_RESERVATION_INVALID", "Gas Station returned an invalid gas reservation", 502, "OBJECTID");
  }
}

function safeError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function isDefinitiveOrAmbiguousSubmission(error: unknown) {
  return error instanceof AppError && [
    "OBJECTID_SPONSORED_TRANSACTION_FAILED",
    "OBJECTID_SPONSORED_SUBMISSION_UNKNOWN",
    "OBJECTID_SPONSORED_CONFIRMATION_UNKNOWN",
  ].includes(error.code);
}
