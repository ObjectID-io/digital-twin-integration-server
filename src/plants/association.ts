import {AppError} from '../common/errors.js';
import {ownerPlants, twinFields} from './twin-membership.js';
import type {PlantService} from './service.js';
import type {CredentialProvider} from '../security/credentials.js';

// Called inside PlantService's write lock. The encrypted document IS the current
// membership record; no separate write can leave binding and membership divergent.
export async function validatePlantBindings(service:PlantService, credentials:CredentialProvider,
  getTwin:(id:string)=>Promise<unknown>, tenantId:string, ownerDid:string, plantId:string, document:any) {
  const plants=await ownerPlants(service,credentials,ownerDid);
  const previous=plants.find(p=>p.scope===tenantId && p.id===plantId);
  const old=(previous?.document.twinIds || {}) as Record<string,string>;
  const seen=new Set<string>();
  const nodes=new Set<string>();
  function visit(node:any) { if(!node || node.type==='document')return;nodes.add(node.id);(node.children || []).forEach(visit); }
  visit(document?.tree);
  for(const [node,id] of Object.entries(document?.twinIds || {})) {
    if(typeof id!=='string' || !/^0x[0-9a-f]{64}$/i.test(id) || !nodes.has(node) || seen.has(id))throw new AppError('PLANT_TWIN_BINDING_CONFLICT','Invalid or duplicate Twin binding',409,'VALIDATION');
    seen.add(id);
    if(old[node]===id)continue;
    const fields=twinFields(await getTwin(id));
    if(fields.owner_did!==ownerDid)throw new AppError('PLANT_TWIN_OWNER_MISMATCH','Twin must belong to the plant supervisor',403,'AUTHORIZATION');
    let origin:any;
    try {origin=JSON.parse(fields.immutable_metadata || '{}');} catch {throw new AppError('PLANT_TWIN_BINDING_CONFLICT','Invalid Twin origin metadata',409,'VALIDATION');}
    if(origin?.tenant_id && (origin.tenant_id!==tenantId || origin.plant_id!==plantId))throw new AppError('TWIN_ALREADY_ASSIGNED','Industrial Twin requires an explicit relocation workflow',409,'VALIDATION');
    for(const plant of plants) {
      if(plant.tenantId===null || (plant.id===plantId && plant.scope===tenantId))continue;
      if(Object.values(plant.document.twinIds || {}).includes(id))throw new AppError('TWIN_ALREADY_ASSIGNED','Twin is already associated with another plant',409,'VALIDATION');
    }
  }
}
