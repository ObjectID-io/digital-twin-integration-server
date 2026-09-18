import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENERGY_DEFAULTS, createEnergyTelemetry, energyParameters } from '../src/energy.js';
import { createTelemetry } from '../src/telemetry.js';
import { applyCommand, createControlServer } from '../src/control-server.js';
import { SimulationStore } from '../src/simulation-store.js';
import { executeSimulatorCommand } from '../src/commands.js';
import { loadSimulatorConfigFromValue } from '../src/config.js';

const input = { sequence: 1, assetId: 'energy-demo', machineName: 'PV demonstrator', now: 1789551000000, energy: { ...ENERGY_DEFAULTS, startAt: '2026-06-21T12:00:00Z' } };
test('energy replay is deterministic, records provenance and is separate from wall clock', () => {
  const a = createEnergyTelemetry(input), b = createEnergyTelemetry({ ...input, now: input.now + 9999 });
  assert.deepEqual(a.measurements,b.measurements);
  assert.deepEqual(a.simulation,b.simulation);
  assert.notEqual(a.observedAt,b.observedAt);
  assert.equal(a.simulation.synthetic,true);
  assert.equal(a.simulation.sampleIndex,0);
  assert.equal(a.simulation.simulatedAt,'2026-06-21T12:00:00.000Z');
  assert.notDeepEqual(a.measurements,createEnergyTelemetry({...input,energy:{...input.energy,seed:43}}).measurements);
  const routed=createTelemetry({...input,profile:'energy',mobile:{enabled:true}});
  assert.equal(routed.schema,'objectid.telemetry.energy.v1');assert.equal(routed.position,undefined);
});
test('daily energy balance holds at every step and solar is zero at night', () => {
  for(let i=0;i<288;i++) {
    const s=createEnergyTelemetry({...input,sequence:i+1});
    const m=s.measurements;
    assert.ok(Math.abs(m.loadPower.value-m.pvPower.value-m.gridPower.value)<0.0011);
    assert.ok(m.pvPower.value>=0 && m.pvPower.value<=input.energy.pvCapacityKw);
    assert.ok(m.gridImportPower.value===0 || m.gridExportPower.value===0);
    const hour=new Date(s.simulation.simulatedAt).getUTCHours();
    if(hour<6 || hour>=18)assert.equal(m.pvPower.value,0);
  }
  assert.ok(createEnergyTelemetry(input).measurements.gridPower.value<0);
  assert.ok(createEnergyTelemetry({...input,energy:{...input.energy,startAt:'2026-06-21T00:00:00Z'}}).measurements.gridPower.value>0);
});
test('cloud, demand and inverter scenarios change the intended physical quantities', () => {
  const base=createEnergyTelemetry(input).measurements;
  const cloud=createEnergyTelemetry({...input,scenario:'cloudy'}).measurements;
  assert.ok(cloud.pvPower.value<base.pvPower.value);assert.equal(cloud.loadPower.value,base.loadPower.value);
  const peak=createEnergyTelemetry({...input,scenario:'demand-peak'}).measurements;
  assert.ok(Math.abs(peak.loadPower.value-2*base.loadPower.value)<=0.0011);assert.equal(peak.pvPower.value,base.pvPower.value);
  const offline=createEnergyTelemetry({...input,scenario:'inverter-offline'});
  assert.equal(offline.measurements.pvPower.value,0);assert.equal(offline.measurements.gridPower.value,offline.measurements.loadPower.value);
  assert.equal(offline.operatingState,'alarm');
});
test('bad parameters and profile-incompatible commands leave control unchanged', () => {
  for(const value of [{seed:-1},{seed:1.1},{stepSeconds:0},{pvCapacityKw:Infinity},{baseLoadKw:'20'},{startAt:'no-date'},{unknown:1}]) assert.throws(()=>energyParameters(value));
  const control={profile:'machine',scenario:'overheat',mobileEnabled:true,paused:true};
  const before={...control};
  assert.throws(()=>applyCommand({action:'profile',profile:'energy',energy:{seed:-1}},control));assert.deepEqual(control,before);
  applyCommand({action:'profile',profile:'energy'},control);
  assert.equal(control.paused,true);assert.equal(control.mobileEnabled,false);assert.equal(control.scenario,'normal');
  assert.throws(()=>applyCommand({action:'scenario',scenario:'overheat'},control));
  assert.throws(()=>applyCommand({action:'enable-mobility'},control));
  assert.throws(()=>executeSimulatorCommand(control,{command:{name:'setSimulationScenario',version:'1.0',parameters:{scenario:'overheat'}}}),/profile/);
  executeSimulatorCommand(control,{command:{name:'setSimulationScenario',version:'1.0',parameters:{scenario:'cloudy'}}});assert.equal(control.scenario,'cloudy');
  applyCommand({action:'profile',profile:'machine'},control);assert.equal(control.scenario,'normal');
  assert.throws(()=>applyCommand({action:'scenario',scenario:'cloudy'},control));
});
test('per-Twin settings survive reload and cannot escape their directory', async t => {
  const directory=await mkdtemp(join(tmpdir(),'sim-energy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const a='0x'+'a'.repeat(64),b='device-11111111-2222-3333-4444-555555555555';
  const store=new SimulationStore(directory);
  await store.save(a,{profile:'energy',energy:{seed:17}});
  const restored=await new SimulationStore(directory).load(a);
  assert.equal(restored.profile,'energy');assert.equal(restored.energy.seed,17);
  assert.equal((await store.load(b)).profile,'machine');
  await assert.rejects(()=>store.save('../bad',{profile:'energy'}),/identity/);
});
test('energy configuration is accepted for bootstrap devices without changing MQTT scope', async () => {
  const id='device-11111111-2222-3333-4444-555555555555';
  const value={specVersion:'objectid.device-onboarding.v1',deviceId:id,network:'testnet',tenantId:'tenant-a',name:'PV',simulation:{profile:'energy',energy:{seed:99}},mqtt:{endpoint:'wss://dtis.objectid.io/mqtt',username:'test',password:'test',topics:{telemetry:`objectid/tenants/tenant-a/devices/${id}/telemetry`}}};
  const config=await loadSimulatorConfigFromValue(value,{});
  assert.equal(config.simulation.profile,'energy');assert.equal(config.simulation.energy.seed,99);
  assert.equal(config.topic,value.mqtt.topics.telemetry);assert.equal(config.stateTopic,'');
});
test('HTTP profile selection affects only the selected Twin and UI exposes energy controls', async t => {
  const controls=new Map([['a',{profile:'machine',scenario:'normal'}],['b',{profile:'machine',scenario:'overheat'}]]);
  const server=createControlServer({port:0,getStatus:()=>({connected:true,twins:[...controls].map(([twinId,c])=>({twinId,...c}))}),controlTwin:async body=>{
    const c=controls.get(body.twinId);if(!c)throw Error('Unknown Twin');applyCommand(body,c);return c;
  }});
  t.after(()=>server.close());await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const html=await (await fetch(url)).text();assert.match(html,/Energy — solar and demand/);assert.match(html,/data-scenario="cloudy"/);assert.match(html,/data-scenario="overheat"/);
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];new Function(script);
  const response=await fetch(url+'/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({twinId:'a',action:'profile',profile:'energy',energy:{seed:7}})});
  assert.equal(response.status,200);assert.equal((await response.json()).energy.seed,7);
  assert.deepEqual(controls.get('b'),{profile:'machine',scenario:'overheat'});
});
