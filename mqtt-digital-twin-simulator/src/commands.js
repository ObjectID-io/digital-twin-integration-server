import { SCENARIOS } from "./telemetry.js";

export function executeSimulatorCommand(control, request) {
  const name = String(request?.command?.name ?? "");
  const parameters = request?.command?.parameters ?? {};
  if (name === "pauseSimulation") control.paused = true;
  else if (name === "resumeSimulation") control.paused = false;
  else if (name === "setSimulationScenario") {
    const scenario = String(parameters.scenario ?? "");
    if (!SCENARIOS.includes(scenario) || scenario === "emergency-stop") throw new Error("Scenario is not allowed through the operational command channel");
    control.scenario = scenario;
  } else throw new Error("Unsupported simulator command");
  control.changedAt = new Date().toISOString();
  return { scenario: control.scenario, paused: control.paused };
}
