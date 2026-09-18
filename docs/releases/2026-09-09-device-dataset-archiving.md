# Device dataset archiving fix

DeviceWorkbench published classified samples to the live hub, then failed the
dataset mapper because the generated mapping omitted the required datasetType.
Consequently live data was visible while evidence export returned
EVIDENCE_SOURCE_EMPTY (404).

The generated mapping now explicitly supplies datasetType `telemetry` and the
device topic. The topic also isolates aggregation windows by source.

Regression tests exercise plaintext and encrypted device samples through the
actual dataset mapper and aggregator, checking the stored Twin reference and
preservation of encryption. All 129 unit tests, four MQTT pipeline integration
tests and TypeScript checking passed.

Testnet: narrow service patch deployed with a pre-release source/image backup
at `/root/backups/dtis-dataset-20260909` on the VPS.

Mainnet audit: the deployed older release does not contain DeviceWorkbench;
its configured dataset mapping already declares `datasetType: telemetry`.
Its compiled mapper/aggregator passed an in-memory smoke test, and retained
datasets exist in its storage. No unrelated mainnet release upgrade was made.

New windows are archived every 300 seconds. Previously unarchived samples cannot
be reconstructed from the retained dataset archive. Production verification
does not create an evidence export, to avoid spending credits or adding chain
events as a side effect of testing.
