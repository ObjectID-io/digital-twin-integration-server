import { describe, it, expect } from 'vitest';
import { classifyPayload } from '../../src/devices/schema.js';
import { simulationContext } from '../../src/devices/simulation.js';
describe('energy telemetry classification', () => {
  const payload = {schema:'objectid.telemetry.energy.v1',simulationScenario:'cloudy',simulation:{synthetic:true,profile:'energy',model:'pv-load-v1',simulatedAt:'2026-06-21T12:00:00Z',sampleIndex:12,secret:'omit'},measurements:{pvPower:{value:12,unit:'kW'}}};
  it('preserves virtual time and energy semantics when signals are renamed', () => {
    const result=classifyPayload(payload,[{key:'solar',source:'/measurements/pvPower/value',name:'PV output',unit:'kW',type:'number'}]);
    expect(result.measurements.solar).toEqual({value:12,unit:'kW',label:'PV output',semanticKey:'pvPower'});
    expect(result.simulation?.simulatedAt).toBe('2026-06-21T12:00:00.000Z');
    expect(result.simulationScenario).toBe('cloudy');expect(result.simulation).not.toHaveProperty('secret');
  });
  it('does not copy arbitrary or malformed simulation data', () => {
    for(const s of [{synthetic:false},{...payload.simulation,simulatedAt:'bad'},{...payload.simulation,sampleIndex:-1}])expect(simulationContext({...payload,simulation:s})).toEqual({});
    expect(simulationContext({...payload,schema:'other'})).toEqual({});
  });
});
