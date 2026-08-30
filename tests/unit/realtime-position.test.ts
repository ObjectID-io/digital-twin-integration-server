import { describe, expect, it } from "vitest";
import { positionFromPayload } from "../../src/realtime/position.js";

describe("realtime mobile asset positions", () => {
  it("normalizes a GeoJSON-compatible position and mobility attributes", () => {
    expect(positionFromPayload({
      observedAt: "2026-08-30T12:00:00.000Z",
      position: {
        type: "Point", coordinates: [9.19, 45.4642, 128.4],
        accuracy: { value: 4.2, unit: "m" }, speed: { value: 10, unit: "m/s" }, heading: { value: 127.5, unit: "deg" },
      },
    }, 1)).toEqual({
      type: "Point", coordinates: [9.19, 45.4642, 128.4], crs: "OGC:CRS84",
      observedAt: Date.parse("2026-08-30T12:00:00.000Z"), accuracyMeters: 4.2, speedKph: 36, headingDegrees: 127.5,
    });
  });

  it("rejects invalid coordinates instead of publishing misleading map data", () => {
    expect(() => positionFromPayload({ position: { coordinates: [190, 45] } }, 1)).toThrow(/longitude/i);
  });
});
