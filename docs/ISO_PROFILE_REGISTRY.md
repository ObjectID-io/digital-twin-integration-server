# ISO Profile Registry

Profiles are filesystem-loaded, versioned manifests. Each manifest declares `id`, semantic version, target standard, type, description, semantic reference, lifecycle status, and either a validation `schema` or a typed `definition`. Only `VALIDATION_PROFILE` manifests are compiled by AJV; maturity and interface profiles expose definitions that are consumed by their respective services. `experimental` means the profile has technical tests but has not completed normative validation.

The stateless `IsoProfileRegistry` exposes discovery, typed definition access, and validation operations. `POST /api/v1/profiles/{profileId}/validate` validates a payload directly, while `POST /api/v1/twins/{id}/validate-profile` also verifies the explicit `OIDTwinAspect` binding. Existing `schema_uri` and `semantic_ref` fields bind that Aspect to a profile without a new Move object.

Profile directories currently include OME, an ObjectID example maturity profile, MQTT, and OPC-UA. Large schemas and examples remain off-chain.
