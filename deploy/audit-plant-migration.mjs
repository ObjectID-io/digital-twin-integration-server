import { loadConfig } from '/app/dist/config/loader.js';
import { FileCredentialProvider, EnvironmentCredentialProvider } from '/app/dist/security/credentials.js';
import { ProviderObjectIdAdapter } from '/app/dist/objectid/adapter.js';
import { StorageProviderFactory } from '/app/dist/storage/storage-provider-factory.js';
import { TenantRegistry } from '/app/dist/security/tenants.js';

const config = await loadConfig();
const credentials = config.security.credentialProvider === 'file' ? new FileCredentialProvider(config.security.credentialFile) : new EnvironmentCredentialProvider();
const tenants = new TenantRegistry(config.security, credentials);
const adapter = new ProviderObjectIdAdapter(config, undefined, credentials);
const storage = new StorageProviderFactory(credentials).createRouter(config.storage);
const plantModule = await import('/app/dist/plants/service.js').catch(() => null);
const service = plantModule ? new plantModule.PlantService(storage, credentials, plantModule.plantCatalogDirectory(config)) : null;
const pins = JSON.parse(await credentials.get('DTIS_PLANT_SUPERVISORS') || '{}');
const plants = [];
for (const [tenantId, ownerDid] of Object.entries(pins)) for (const plant of await service.list(tenantId)) {
  plants.push({ tenantId, ownerDid, id: plant.id, revision: plant.revision, documentOwner: plant.document.ownerDid || null,
    twinIds: plant.document.twinIds || {}, nodeIds: [], name: plant.document.tree?.name,
    publication: plant.publication, documents: Object.keys(plant.document.attachments || {}).length });
  const collect = n => { if (!n) return; plants.at(-1).nodeIds.push(n.id); (n.children || []).forEach(collect); }; collect(plant.document.tree);
}
const ids = await adapter.listTwinIdsForRetention();
const twins = [];
for (const id of ids) {
  const raw = await adapter.getTwin(id);
  const f = raw?.data?.content?.fields ?? raw?.content?.fields ?? raw?.fields ?? {};
  let immutable = {}; try { immutable = JSON.parse(f.immutable_metadata || '{}'); } catch {}
  const ownerDid = f.owner_did ?? f.ownerDid;
  const accounting = ownerDid ? await tenants.findByOwnerDid(ownerDid) : undefined;
  twins.push({ id, name: f.name, ownerDid, subscriptionId: f.subscription_id, immutable,
    registered: Boolean(accounting), accountingMatches: accounting?.subscriptionId === f.subscription_id,
    version: raw?.data?.version ?? raw?.version, digest: raw?.data?.digest ?? raw?.digest });
}
console.log(JSON.stringify({ network: config.objectid.network, signer: { enabled: config.objectid.signer?.enabled, delegated: config.objectid.signer?.delegatedAccounts },
  plantKeyConfigured: Boolean(await credentials.get('DTIS_PLANT_ENCRYPTION_KEY')), catalog: plantModule?.plantCatalogDirectory(config),
  pins, plants, twins }, null, 2));
