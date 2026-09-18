// Device-declared simulation context is not an identity or provenance attestation.
// Keep only the bounded fields needed to distinguish virtual time from receipt time.
const scenarios = new Set(['normal', 'cloudy', 'demand-peak', 'inverter-offline']);
export const energyKeys = new Set(['pvPower','loadPower','gridPower','gridImportPower','gridExportPower','solarIrradiance']);
export function simulationContext(payload: unknown): { simulation?: { synthetic: boolean; profile: string; model: string; simulatedAt: string; sampleIndex: number }; simulationScenario?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, any>, s = p.simulation;
  if (p.schema !== 'objectid.telemetry.energy.v1' || s?.synthetic !== true || s.profile !== 'energy' || s.model !== 'pv-load-v1' ||
      typeof s.simulatedAt !== 'string' || s.simulatedAt.length > 32 || !Number.isFinite(Date.parse(s.simulatedAt)) ||
      !Number.isSafeInteger(s.sampleIndex) || s.sampleIndex < 0) return {};
  return { simulation: { synthetic: true, profile: 'energy', model: 'pv-load-v1', simulatedAt: new Date(s.simulatedAt).toISOString(), sampleIndex: s.sampleIndex },
    ...(scenarios.has(p.simulationScenario) ? { simulationScenario: p.simulationScenario as string } : {}) };
}
