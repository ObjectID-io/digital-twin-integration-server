import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CommandRecord } from "./types.js";

export class CommandStore {
  private readonly records = new Map<string, CommandRecord>();
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(private readonly file: string) {}

  async initialize() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await readFile(resolve(this.file), "utf8"));
      for (const record of Array.isArray(data) ? data : []) this.records.set(record.commandId, record);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  async put(record: CommandRecord) {
    await this.initialize();
    this.records.set(record.commandId, structuredClone(record));
    await this.persist();
    return structuredClone(record);
  }

  async get(twinId: string, commandId: string) {
    await this.initialize();
    const value = this.records.get(commandId);
    return value?.twinId === twinId ? structuredClone(value) : undefined;
  }

  async has(commandId: string) { await this.initialize(); return this.records.has(commandId); }

  async list(twinId: string, limit = 50) {
    await this.initialize();
    return [...this.records.values()].filter((item) => item.twinId === twinId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, Math.max(1, Math.min(limit, 200)))
      .map((item) => structuredClone(item));
  }

  private async persist() {
    this.writeChain = this.writeChain.then(async () => {
      const target = resolve(this.file);
      const temporary = `${target}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, `${JSON.stringify([...this.records.values()], null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    });
    await this.writeChain;
  }
}
