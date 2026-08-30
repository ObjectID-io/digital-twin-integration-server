import { AppError } from "../common/errors.js";

export interface TwinPosition {
  type: "Point";
  coordinates: [number, number] | [number, number, number];
  crs: "OGC:CRS84";
  observedAt: number;
  accuracyMeters?: number;
  speedKph?: number;
  headingDegrees?: number;
}

export function positionFromPayload(payload: unknown, fallbackObservedAt: number): TwinPosition | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, any>;
  const candidate = root.position ?? root.location;
  if (candidate === undefined) return undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw invalid("Position must be an object");

  const coordinates = Array.isArray(candidate.coordinates)
    ? candidate.coordinates
    : [candidate.longitude ?? candidate.lng ?? candidate.lon, candidate.latitude ?? candidate.lat, candidate.altitude ?? candidate.alt];
  const longitude = finite(coordinates[0], "longitude");
  const latitude = finite(coordinates[1], "latitude");
  if (longitude < -180 || longitude > 180) throw invalid("Position longitude must be between -180 and 180");
  if (latitude < -90 || latitude > 90) throw invalid("Position latitude must be between -90 and 90");
  const altitude = optionalFinite(coordinates[2], "altitude");
  const accuracyMeters = quantity(candidate.accuracy, "accuracy", ["m", "meter", "meters"]);
  const speedKph = speed(candidate.speed);
  const headingDegrees = optionalFinite(quantityValue(candidate.heading), "heading");
  if (accuracyMeters !== undefined && accuracyMeters < 0) throw invalid("Position accuracy cannot be negative");
  if (speedKph !== undefined && speedKph < 0) throw invalid("Position speed cannot be negative");
  if (headingDegrees !== undefined && (headingDegrees < 0 || headingDegrees >= 360)) throw invalid("Position heading must be between 0 inclusive and 360 exclusive");
  const observedAt = timestamp(root.observedAt ?? candidate.observedAt, fallbackObservedAt);
  return {
    type: "Point",
    coordinates: altitude === undefined ? [longitude, latitude] : [longitude, latitude, altitude],
    crs: "OGC:CRS84",
    observedAt,
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    ...(speedKph === undefined ? {} : { speedKph }),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
  };
}

function quantity(value: unknown, name: string, supportedUnits: string[]) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return finite(value, name);
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`Position ${name} must be numeric or a quantity`);
  const quantity = value as Record<string, unknown>;
  const unit = String(quantity.unit ?? supportedUnits[0]).toLowerCase();
  if (!supportedUnits.includes(unit)) throw invalid(`Position ${name} unit '${unit}' is not supported`);
  return finite(quantity.value, name);
}

function speed(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return finite(value, "speed");
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Position speed must be numeric or a quantity");
  const quantity = value as Record<string, unknown>;
  const numeric = finite(quantity.value, "speed");
  const unit = String(quantity.unit ?? "km/h").toLowerCase();
  if (["km/h", "kmh", "kph"].includes(unit)) return numeric;
  if (["m/s", "mps"].includes(unit)) return numeric * 3.6;
  if (["kn", "knot", "knots"].includes(unit)) return numeric * 1.852;
  throw invalid(`Position speed unit '${unit}' is not supported`);
}

function quantityValue(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>).value;
  return value;
}

function timestamp(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(numeric) || numeric < 0) throw invalid("Position observedAt is invalid");
  return numeric;
}

function optionalFinite(value: unknown, name: string) {
  return value === undefined || value === null || value === "" ? undefined : finite(value, name);
}

function finite(value: unknown, name: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw invalid(`Position ${name} must be a finite number`);
  return numeric;
}

function invalid(message: string) {
  return new AppError("REALTIME_POSITION_INVALID", message, 422, "VALIDATION");
}
