import type { IotaClient } from '@iota/iota-sdk/client';

// Original type origins, verified against the packages selected by IOTA Identity
// SDK 1.8.0-beta.2 on each network. Upgrade package IDs differ from type origins.
export const IOTA_IDENTITY_ORIGINS: Record<string, string> = {
  testnet: '0x222741bbdff74b42df48a7b4733185e9b24becb8ccfbafe8eac864ab4e4cc555',
  mainnet: '0x84cf5d12de2f9731a89bb519bc0c982a941b319a33abefdd5ed2054ad931de08',
};

export async function ownsIdentityController(client: Pick<IotaClient, 'getOwnedObjects' | 'getObject'>, network: string, objectIdPackage: string, did: string, address: string) {
  const prefix = network === 'mainnet' ? 'did:iota:' : `did:iota:${network}:`;
  const controllerOf = did.toLowerCase().slice(prefix.length);
  if (!did.toLowerCase().startsWith(prefix) || !/^0x[0-9a-f]{64}$/.test(controllerOf) || !/^0x[0-9a-f]{64}$/i.test(objectIdPackage)) return false;
  const legacyType = `${objectIdPackage.toLowerCase()}::oid_identity::ControllerCap`;
  const origin = IOTA_IDENTITY_ORIGINS[network], nativeType = origin ? `${origin}::controller::ControllerCap` : '';
  let cursor: string | null | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await client.getOwnedObjects({ owner: address, cursor, limit: 50,
      filter: nativeType ? { MatchAny: [{ StructType: legacyType }, { StructType: nativeType }] } : { StructType: legacyType },
      options: { showType: true, showContent: true, showOwner: true } });
    for (const item of page.data) {
      const data = item.data, type = data?.type;
      if (!data || ![legacyType, nativeType].includes(type ?? '') || data.content?.dataType !== 'moveObject') continue;
      const fields = data.content.fields as Record<string, any>;
      if (String(fields.controller_of).toLowerCase() !== controllerOf) continue;
      if (!data.owner || typeof data.owner !== 'object' || !('AddressOwner' in data.owner) || data.owner.AddressOwner.toLowerCase() !== address.toLowerCase()) continue;
      if (type === legacyType) return true;
      const identity = await client.getObject({ id: controllerOf, options: { showType: true, showContent: true } });
      if (identity.data?.type !== `${origin}::identity::Identity` || identity.data.content?.dataType !== 'moveObject') continue;
      const identityFields = identity.data.content.fields as Record<string, any>;
      if (identityFields.deleted !== false || identityFields.deleted_did !== false) continue;
      const activeControllers = identityFields.did_doc?.fields?.controllers?.fields?.contents;
      if (Array.isArray(activeControllers) && activeControllers.some(entry => String(entry?.fields?.key).toLowerCase() === data.objectId.toLowerCase() && /^\d+$/.test(String(entry?.fields?.value)) && BigInt(entry.fields.value) > 0n)) return true;
    }
    if (!page.hasNextPage || !page.nextCursor || page.nextCursor === cursor) return false;
    cursor = page.nextCursor;
  }
  return false;
}
