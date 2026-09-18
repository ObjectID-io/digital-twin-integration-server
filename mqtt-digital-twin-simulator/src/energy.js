export const ENERGY_SCENARIOS = ['normal', 'cloudy', 'demand-peak', 'inverter-offline'];
export const ENERGY_DEFAULTS = Object.freeze({ seed: 42, pvCapacityKw: 50, baseLoadKw: 20, startAt: '2026-06-21T06:00:00.000Z', stepSeconds: 300 });

export function energyParameters(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Energy parameters must be an object');
  if (Object.keys(value).some(key => !(key in ENERGY_DEFAULTS))) throw new Error('Unknown energy parameter');
  const result = { ...ENERGY_DEFAULTS, ...value };
  for (const [key, min, max, integer] of [['seed',0,4294967295,true],['pvCapacityKw',0.1,10000,false],['baseLoadKw',0,10000,false],['stepSeconds',1,3600,true]]) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max || (integer && !Number.isInteger(result[key]))) throw new Error(`Invalid energy parameter: ${key}`);
  }
  if (typeof result.startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(result.startAt) || !Number.isFinite(Date.parse(result.startAt))) throw new Error('Energy startAt must be a UTC ISO timestamp');
  result.startAt = new Date(result.startAt).toISOString();
  return result;
}

export function simulationSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid simulation settings');
  const profile = value.profile ?? 'machine';
  if (!['machine','energy'].includes(profile)) throw new Error('Unsupported simulation profile');
  return { profile, energy: energyParameters(value.energy) };
}

function noise(seed, step, channel) {
  let n = (seed ^ Math.imul(step + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0;
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15; n = Math.imul(n, 0x846ca68b); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
const round = value => Math.round(value * 1000) / 1000;

export function createEnergyTelemetry({ sequence, machineName, assetId, scenario = 'normal', now = Date.now(), energy = ENERGY_DEFAULTS, energyStep = sequence - 1 }) {
  const parameters = energyParameters(energy);
  if (!ENERGY_SCENARIOS.includes(scenario)) throw new Error('Scenario is not available for the energy profile');
  if (!Number.isSafeInteger(energyStep) || energyStep < 0) throw new Error('Invalid energy sample index');
  const simulatedAt = new Date(Date.parse(parameters.startAt) + energyStep * parameters.stepSeconds * 1000);
  const hour = simulatedAt.getUTCHours() + simulatedAt.getUTCMinutes() / 60 + simulatedAt.getUTCSeconds() / 3600;
  const daylight = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
  const cloudFactor = scenario === 'cloudy' ? 0.2 + noise(parameters.seed, energyStep, 0) * 0.2 : 0.95 + noise(parameters.seed, energyStep, 0) * 0.05;
  const irradiance = round(1000 * daylight * cloudFactor);
  const pv = scenario === 'inverter-offline' ? 0 : round(parameters.pvCapacityKw * irradiance / 1000);
  const dailyLoad = 0.65 + 0.35 * Math.max(0, Math.sin(Math.PI * (hour - 5) / 16));
  const load = round(parameters.baseLoadKw * dailyLoad * (0.95 + noise(parameters.seed, energyStep, 1) * 0.1) * (scenario === 'demand-peak' ? 2 : 1));
  const grid = round(load - pv);
  return {
    schema: 'objectid.telemetry.energy.v1', assetId, machineName, sequence, observedAt: new Date(now).toISOString(),
    operatingState: scenario === 'inverter-offline' ? 'alarm' : scenario === 'demand-peak' ? 'warning' : 'running', simulationScenario: scenario,
    simulation: { synthetic: true, model: 'pv-load-v1', profile: 'energy', sampleIndex: energyStep, simulatedAt: simulatedAt.toISOString(), parameters, gridConvention: 'positive-import-negative-export' },
    measurements: {
      solarIrradiance: { value: irradiance, unit: 'W/m2' }, pvPower: { value: pv, unit: 'kW' },
      loadPower: { value: load, unit: 'kW' }, gridPower: { value: grid, unit: 'kW' },
      gridImportPower: { value: Math.max(0, grid), unit: 'kW' }, gridExportPower: { value: Math.max(0, -grid), unit: 'kW' }
    }
  };
}
