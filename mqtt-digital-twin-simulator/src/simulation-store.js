import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { simulationSettings } from './energy.js';

export class SimulationStore {
  constructor(directory) { this.directory = directory; }
  path(id) {
    if (!/^(0x[0-9a-f]{64}|device-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(id)) throw new Error('Invalid simulator identity');
    return join(this.directory, `${id}.json`);
  }
  async load(id, fallback) {
    try { return simulationSettings(JSON.parse(await readFile(this.path(id), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return simulationSettings(fallback); throw error; }
  }
  async save(id, settings) {
    const path = this.path(id), value = simulationSettings(settings);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
}
