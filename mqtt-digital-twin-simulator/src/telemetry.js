function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createTelemetry({ sequence, machineName, assetId, now = Date.now(), random = Math.random }) {
  const phase = sequence / 12;
  const noise = () => random() - 0.5;
  const temperatureC = clamp(62 + Math.sin(phase) * 7 + noise() * 1.5, 45, 85);
  const vibrationMmS = clamp(1.8 + Math.sin(phase * 1.7) * 0.65 + noise() * 0.3, 0.2, 5.5);
  const rpm = clamp(1450 + Math.sin(phase * 0.7) * 90 + noise() * 20, 1200, 1700);
  const powerKw = clamp(18.5 + Math.sin(phase * 0.9) * 2.2 + noise() * 0.8, 12, 25);
  const pressureBar = clamp(5.8 + Math.sin(phase * 0.5) * 0.35 + noise() * 0.1, 4.5, 7);

  return {
    schema: "objectid.telemetry.machine.v1",
    assetId,
    machineName,
    sequence,
    observedAt: new Date(now).toISOString(),
    operatingState: temperatureC > 78 || vibrationMmS > 4.5 ? "warning" : "running",
    measurements: {
      temperature: { value: round(temperatureC), unit: "Cel" },
      vibration: { value: round(vibrationMmS), unit: "mm/s" },
      rotationalSpeed: { value: Math.round(rpm), unit: "rpm" },
      activePower: { value: round(powerKw), unit: "kW" },
      pressure: { value: round(pressureBar), unit: "bar" }
    }
  };
}
