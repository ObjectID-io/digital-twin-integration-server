function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export const SCENARIOS = ["normal", "overheat", "high-vibration", "spindle-overload", "pressure-loss", "emergency-stop"];

export function createTelemetry({ sequence, machineName, assetId, scenario = "normal", now = Date.now(), random = Math.random, mobile = null }) {
  const phase = sequence / 12;
  const noise = () => random() - 0.5;
  const temperatureC = clamp(62 + Math.sin(phase) * 7 + noise() * 1.5, 45, 85);
  const vibrationMmS = clamp(1.8 + Math.sin(phase * 1.7) * 0.65 + noise() * 0.3, 0.2, 5.5);
  const rpm = clamp(1450 + Math.sin(phase * 0.7) * 90 + noise() * 20, 1200, 1700);
  const powerKw = clamp(18.5 + Math.sin(phase * 0.9) * 2.2 + noise() * 0.8, 12, 25);
  let pressureBar = clamp(5.8 + Math.sin(phase * 0.5) * 0.35 + noise() * 0.1, 4.5, 7);
  let simulatedTemperature = temperatureC;
  let simulatedVibration = vibrationMmS;
  let simulatedRpm = rpm;
  let simulatedPower = powerKw;
  let operatingState = "running";

  if (scenario === "overheat") { simulatedTemperature = 96 + noise() * 2; operatingState = "alarm"; }
  if (scenario === "high-vibration") { simulatedVibration = 8.4 + noise(); operatingState = "alarm"; }
  if (scenario === "spindle-overload") { simulatedRpm = 5200 + noise() * 80; simulatedPower = 34 + noise(); operatingState = "warning"; }
  if (scenario === "pressure-loss") { pressureBar = 2.1 + noise() * 0.2; operatingState = "alarm"; }
  if (scenario === "emergency-stop") {
    simulatedRpm = 0; simulatedPower = 0; simulatedVibration = 0; operatingState = "emergency-stop";
  }
  if (scenario === "normal" && (simulatedTemperature > 78 || simulatedVibration > 4.5)) operatingState = "warning";

  const position = mobile?.enabled ? simulatedPosition(sequence, mobile) : undefined;
  return {
    schema: position ? "objectid.telemetry.mobile-asset.v1" : "objectid.telemetry.machine.v1",
    assetId,
    machineName,
    sequence,
    observedAt: new Date(now).toISOString(),
    operatingState,
    simulationScenario: scenario,
    ...(position ? { position } : {}),
    measurements: {
      temperature: { value: round(simulatedTemperature), unit: "Cel" },
      vibration: { value: round(simulatedVibration), unit: "mm/s" },
      rotationalSpeed: { value: Math.round(simulatedRpm), unit: "rpm" },
      activePower: { value: round(simulatedPower), unit: "kW" },
      pressure: { value: round(pressureBar), unit: "bar" }
    }
  };
}

function simulatedPosition(sequence, mobile) {
  const centerLatitude = Number(mobile.centerLatitude);
  const centerLongitude = Number(mobile.centerLongitude);
  const radiusKm = Number(mobile.radiusKm);
  const speedKph = Number(mobile.speedKph);
  const stepSeconds = Number(mobile.intervalMs) / 1000;
  const circumferenceKm = Math.max(0.01, 2 * Math.PI * radiusKm);
  const angle = ((sequence * speedKph * stepSeconds / 3600) / circumferenceKm) * Math.PI * 2;
  const latitude = centerLatitude + (radiusKm / 111.32) * Math.sin(angle);
  const longitude = centerLongitude + (radiusKm / (111.32 * Math.cos(centerLatitude * Math.PI / 180))) * Math.cos(angle);
  return {
    type: "Point",
    coordinates: [round(longitude, 6), round(latitude, 6)],
    crs: "OGC:CRS84",
    accuracy: { value: 4.5, unit: "m" },
    speed: { value: round(speedKph, 1), unit: "km/h" },
    heading: { value: round((90 - angle * 180 / Math.PI + 360) % 360, 1), unit: "deg" },
  };
}
