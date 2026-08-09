import { AppError } from "../common/errors.js";
import { createHash } from "node:crypto";
import type { ProfileRegistry } from "../schemas/registry.js";
import type { StorageProvider } from "../storage/types.js";

export interface MaturityEvidence {
  indicator: string;
  value: number | boolean;
  uri?: string;
  hash?: string;
  data?: unknown;
  contentType?: string;
  fileName?: string;
  size?: number;
}
export interface MaturityResult {
  profile: string;
  profileId: string;
  profileVersion: string;
  engineVersion: string;
  level: number;
  score: number;
  indicators: Array<{ code: string; score: number; weight: number; passed: boolean; evidence?: MaturityEvidence }>;
  inputIndicators: Array<{ code: string; value: number | boolean }>;
  evidenceHashes: string[];
  evaluationHash: string;
}

interface MaturityProfile {
  version?: string | number;
  scoringRule?: "weighted-average";
  indicators: Array<{ code: string; weight: number; threshold: number; minimum?: number; requiredEvidence?: boolean }>;
  levels: Array<{ level: number; minimumScore: number }>;
}

export class MaturityEngine {
  static readonly version = "1.0.0";
  constructor(private readonly profiles: ProfileRegistry, private readonly storage?: StorageProvider) {}
  async prepareEvidence(twinId: string, evidence: MaturityEvidence[]) {
    return Promise.all(evidence.map(async (item) => {
      if (item.data === undefined || item.uri) return item;
      if (!this.storage) throw new AppError("MATURITY_STORAGE_UNAVAILABLE", "Evidence storage is not configured", 503, "MATURITY");
      const data = Buffer.from(typeof item.data === "string" ? item.data : JSON.stringify(item.data));
      const stored = await this.storage.store({
        data, contentType: item.contentType ?? "application/json", fileName: item.fileName ?? `${item.indicator}.json`,
        category: "evidence", twinId, metadata: { indicator: item.indicator },
      });
      return { ...item, data: undefined, uri: stored.uri, hash: stored.hash, size: stored.size, contentType: stored.contentType };
    }));
  }
  async evaluate(profileName: string, evidence: MaturityEvidence[], twinId = "unscoped"): Promise<MaturityResult> {
    evidence = await this.prepareEvidence(twinId, evidence);
    const profileId = profileName === "default-v1" ? "objectid-maturity-example-v1" : profileName;
    const uri = profileId.startsWith("objectid-profile://")
      ? profileId
      : profileId === "objectid-maturity-example-v1" ? "objectid-profile://maturity/default/v1" : profileId;
    const profile = await this.profiles.getMaturityDefinition(uri) as unknown as MaturityProfile;
    const profileVersion = await this.profiles.getProfileVersion(uri).catch(() => String(profile.version ?? "NOT_VERIFIED"));
    const evidenceByCode = new Map(evidence.map((item) => [item.indicator, item]));
    const totalWeight = profile.indicators.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) throw new AppError("MATURITY_PROFILE_INVALID", "Maturity profile has no positive weight", 500, "MATURITY");
    const indicators = profile.indicators.map((indicator) => {
      const item = evidenceByCode.get(indicator.code);
      if (indicator.requiredEvidence && (!item?.uri || !item.hash)) {
        throw new AppError("MATURITY_EVIDENCE_REQUIRED", `Evidence is required for '${indicator.code}'`, 422, "MATURITY");
      }
      const numeric = typeof item?.value === "boolean" ? (item.value ? 100 : 0) : Number(item?.value ?? 0);
      const score = Math.max(0, Math.min(100, numeric));
      const minimumMet = indicator.minimum === undefined || score >= indicator.minimum;
      return { code: indicator.code, score, weight: indicator.weight, passed: minimumMet && score >= indicator.threshold, evidence: item };
    });
    const score = Math.round(indicators.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
    const level = [...profile.levels].sort((a, b) => a.minimumScore - b.minimumScore)
      .filter((entry) => score >= entry.minimumScore).at(-1)?.level ?? 0;
    const inputIndicators = evidence.map(({ indicator, value }) => ({ code: indicator, value }));
    const evidenceHashes = evidence.flatMap((item) => item.hash ? [item.hash] : []).sort();
    const reproducibility = { profileId, profileVersion, engineVersion: MaturityEngine.version, inputIndicators, evidenceHashes, score, level };
    const evaluationHash = `sha256:${createHash("sha256").update(stableJson(reproducibility)).digest("hex")}`;
    return {
      profile: profileName, profileId, profileVersion, engineVersion: MaturityEngine.version,
      level, score, indicators, inputIndicators, evidenceHashes, evaluationHash,
    };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
