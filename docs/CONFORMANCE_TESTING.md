# Conformance Testing

`npm run test:conformance` runs technical assertions grouped by alignment target under `tests/conformance`. Stable IDs such as `DT-23247-5-001` map back to `docs/iso-conformance-matrix.json`.

`npm run conformance-report` writes Vitest JSON evidence to `reports/conformance-results.json` and regenerates `docs/ISO_CONFORMANCE_REPORT.md`. A passing assertion proves only the implemented behavior; it does not turn a `PARTIAL` or `NOT_VERIFIED` normative status into `SATISFIED`.

Use WSL with Node `20.20.0` and npm `10.8.2`. CI retains test reports, the generated report, matrix, and build output as evidence artifacts.
