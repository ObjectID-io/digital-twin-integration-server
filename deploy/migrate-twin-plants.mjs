import { createHash } from 'node:crypto';
import { loadConfig } from '/app/dist/config/loader.js';
import { FileCredentialProvider, EnvironmentCredentialProvider } from '/app/dist/security/credentials.js';
import { ProviderObjectIdAdapter } from '/app/dist/objectid/adapter.js';
import { StorageProviderFactory } from '/app/dist/storage/storage-provider-factory.js';
import { PlantService, plantCatalogDirectory } from '/app/dist/plants/service.js';
import { TenantRegistry } from '/app/dist/security/tenants.js';
import { migrateTwinPlant, locateTwinPlant, twinFields } from '/app/dist/plants/twin-membership.js';

const apply = process.argv.includes('--apply');
const config = await loadConfig();
const credentials = config.security.credentialProvider === 'file' ? new FileCredentialProvider(config.security.credentialFile) : new EnvironmentCredentialProvider();
const tenants = new TenantRegistry(config.security, credentials), adapter = new ProviderObjectIdAdapter(config, undefined, credentials);
const storage = new StorageProviderFactory(credentials).createRouter(config.storage);
const service = new PlantService(storage, credentials, plantCatalogDirectory(config));
const pins = JSON.parse(await credentials.get('DTIS_PLANT_SUPERVISORS') || '{}');
const protectedHash = raw => { const f = twinFields(raw); return createHash('sha256').update(JSON.stringify([f.owner_did, f.subscription_id, f.immutable_metadata, f.mutable_metadata])).digest('hex'); };
const plan = [];
for (const twinId of await adapter.listTwinIdsForRetention()) {
  const raw = await adapter.getTwin(twinId), f = twinFields(raw);
  const accounting = await tenants.findByOwnerDid(f.owner_did);
  if (!accounting) throw new Error(`Unregistered owner for Twin ${twinId}; migration stopped before writes`);
  plan.push({ twinId, raw, accounting, hash: protectedHash(raw), planned: await migrateTwinPlant(service, credentials, twinId, raw, accounting) });
}
const plants = [];
for (const [tenantId, ownerDid] of Object.entries(pins)) for (const plant of await service.list(tenantId)) {
  if (plant.document.ownerDid && plant.document.ownerDid !== ownerDid) throw new Error(`Owner mismatch for ${plant.id}`);
  plants.push({ tenantId, ownerDid, ...plant });
}
if (apply) {
  for (const plant of plants) {
    if (plant.document.ownerDid === plant.ownerDid && plant.document.tenantId === plant.tenantId) continue;
    await service.put(plant.tenantId, plant.id, { revision: plant.revision, publication: plant.publication,
      document: { ...plant.document, ownerDid: plant.ownerDid, tenantId: plant.tenantId } });
  }
  for (const item of plan) await migrateTwinPlant(service, credentials, item.twinId, item.raw, item.accounting, true);
}
const results = [];
for (const item of plan) {
  const current = await adapter.getTwin(item.twinId);
  if (protectedHash(current) !== item.hash) throw new Error(`On-chain ownership/metadata changed concurrently: ${item.twinId}`);
  const membership = await locateTwinPlant(service, credentials, item.twinId, current, item.accounting);
  if (apply && !membership) throw new Error(`Membership verification failed: ${item.twinId}`);
  results.push({ twinId: item.twinId, name: twinFields(current).name, action: item.planned.action, membership: membership || item.planned, onChainUnchanged: true });
}
for (const before of plants) {
  const after = (await service.list(before.tenantId)).find(p => p.id === before.id);
  const { ownerDid: _owner, tenantId: _tenant, ...beforeContent } = before.document;
  const { ownerDid: _newOwner, tenantId: _newTenant, ...afterContent } = after.document;
  if (JSON.stringify(beforeContent) !== JSON.stringify(afterContent) || JSON.stringify(before.publication) !== JSON.stringify(after.publication)) throw new Error(`Existing plant content or publication changed: ${before.id}`);
}
console.log(JSON.stringify({ version: 1, network: config.objectid.network, mode: apply ? 'applied-and-verified' : 'dry-run', twinCount: results.length, existingPlantsPreserved: plants.length, results }, null, 2));
