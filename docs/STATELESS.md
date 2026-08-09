# Stateless Design

## Authoritative State

ObjectID/IOTA is authoritative for Twin identity, children, revisions, events,
hashes and authorization. Industrial systems and document stores are
authoritative for raw telemetry, engineering files and business records.

## Ephemeral State

Memory cache, queue, failed jobs, rate-limit counters, dataset windows and
memory idempotency responses are reconstructable and disposable. Buffered MQTT
samples can be lost on abrupt termination. Filesystem, NAS or object storage is
external application infrastructure, not private Integration Server state.

## Recovery And Scaling

After restart the server reconstructs Twin and Digital Thread data from
ObjectID and recreates subscriptions from configuration. Instances require no
sticky sessions. Optional Redis provides atomic cross-instance idempotency
acquisition but remains shared ephemeral coordination, never source of truth.
Any new instance can use the same configured storage and resolve the URI/hash
already registered in ObjectID; no server-state migration is required.

## Idempotency And Retry

Mutations accept `Idempotency-Key`. Memory or Redis rejects key reuse with a
different body and replays completed responses. MQTT jobs add a deterministic
external reference. If an ObjectID mutation outcome is ambiguous and the SDK
cannot query that reference, the worker does not retry blindly.

The source of truth for aggregated telemetry remains the industrial source,
durable dataset storage when configured, and ObjectID registration. The server
does not claim durable stream ingestion with its default memory queue.
