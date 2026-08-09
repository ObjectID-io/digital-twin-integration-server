# Twin Indexer Operations

`TwinIndexer` separates the stateless Integration Server from a persistent derived read model. Status is deliberately split:

| Capability | Status | Limitation |
|---|---|---|
| Indexer abstraction | IMPLEMENTED | Storage-neutral boundary |
| ObjectID indexed provider delegation | IMPLEMENTED | Requires matching SDK provider methods |
| Persistent derived read model | PARTIAL / PROVIDER DEPENDENT | No database is bundled with this server |
| Cursor pagination and filters | IMPLEMENTED | Provider must execute them; no get-all fallback exists |
| Checkpoint/resume/rebuild | PARTIAL / PROVIDER DEPENDENT | Hooks are delegated to the external provider |

Every external indexer checkpoint must record the last processed checkpoint, network, Digital Twin package ID, indexer schema version, and timestamp. Resume continues after that checkpoint. Rebuild discards only derived index data and replays the configured package history from IOTA. It must never alter chain objects or become the source of truth.

Production deployments must configure an ObjectID provider exposing indexed lookup methods. The server returns an explicit provider-capability error rather than scanning the full chain. The abstraction alone is not described as a production-grade persistent indexer.
