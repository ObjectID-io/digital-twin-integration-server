# Signed historical datasets

Authorized clients can export retained telemetry without creating a new IOTA
Dataset object. This is separate from Portable evidence bundles that anchor an
export on-chain. Both testnet and mainnet use the same implementation with their
own network, issuer and signing-key configuration.

## DID session and API

Under `/api/v1/shared/twins/{id}`, call `POST /challenge` with the requesting DID,
sign the returned message using that DID's controller, then `POST /verify` with
`{did, challengeId, signature}`. Send the returned opaque token only through
`Authorization: Bearer <token>` on subsequent requests. Do not put it in URLs.

| Route under the Twin base path | Purpose |
| --- | --- |
| `GET /datasets/context` | Authorized periods, measurement scope and limits. |
| `POST /history/query` | Filtered historical samples; requires History. |
| `POST /datasets` | Prepare ZIP; requires Download/export, which includes History. |
| `GET /datasets/{requestId}` | Preparation status. |
| `GET /datasets/{requestId}/download` | Authenticated ZIP download. |
| `DELETE /datasets/{requestId}` | Discard or cancel. |

Selection is `{fromTimestamp, toTimestamp, measurements?}` in Unix milliseconds.
The query end is inclusive; the grant's history end is exclusive. The maximum
query span is 31 days; exact measurement keys must be authorized. Consult the
context response for current limits. Realtime-only and anonymous public access
do not grant historical downloads. Active owner/Admin rights authorize management
and data access; reader requests remain subject to their individual scopes.

The server reads retained, flushed windows through StorageRouter, including
private providers. Encrypted sources require a configured source-side decryption
key; unavailable keys fail closed. Filtering precedes export. Storage credentials
and private provider URLs are not exposed to the recipient.

ZIPs are held in process memory, bounded to 16 MiB, for at most 10 minutes or the
original session expiry, whichever comes first. Restart removes them. Status and
download recheck the DID, Twin, original session token and policy revision; a URL
or request ID alone is not sufficient. Revocation or a policy change invalidates
the prepared archive. Already downloaded copies cannot be recalled.

## Manifest signature

The ZIP contains exactly `data.json`, `data.csv` and `manifest.json`.
`objectid.shared-dataset-manifest.v2` is canonical JSON with file hashes, selection,
source references and an Ed25519 signature produced by the Integration Server's
dedicated key, not by the owner or requesting DID.

To verify the signature, remove only `signature.value`, canonicalize the rest
using RFC 8785 JCS, and verify the Ed25519 signature over UTF-8 bytes of
`ObjectID signed dataset manifest v2\n` followed by that canonical JSON. The key
ID is SHA-256 of DER SPKI; `publicKey` is base64 DER SPKI. Verify archive structure,
file lengths/hashes and dataset consistency separately, and match the issuer,
network and key against an independently approved trust registry.

`DTIS_DATASET_SIGNING_KEY_FILE` overrides the persistent default
`<DTIS_SHARING_DIRECTORY>/dataset-signing-key.json` (normally
`/data/twin-sharing/dataset-signing-key.json`). Preserve and securely back up this
key; do not rotate it when a data session expires. Invalid existing keys or an
issuer/network mismatch fail closed. Public identity is advertised at
`/.well-known/objectid-dataset-keys.json`, relative to the server base URL.
Publication alone does not make a key trusted. Customer-hosted keys need explicit
approval by the validating webview's operator.

The signature attests to the server's export, not sensor accuracy, owner approval,
a trusted timestamp, current access rights or an IOTA attestation. Legacy v1 ZIPs
are unsigned. A valid signature with an unknown key is not a verified identity.

## Webview workflow

After normal DID login, open the Twin's **Data download** tab, select period and
measurements, and prepare/download the ZIP. **VALIDATE DATASET ZIP** in Data
download or Digital thread opens a popup. Validation runs locally in a browser
worker without uploading ZIP contents; only the approved public-key registry is
fetched. Close with **CLOSE ×** or **Esc** to keep the original download selection.
The same checks are public at the webview's `/validate-dataset` route. The JSON
validation report is not itself signed. Portable evidence bundles use their
separate **VALIDATE ZIP AGAINST IOTA** workflow.
