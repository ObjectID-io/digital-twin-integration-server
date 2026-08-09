import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFilesystemDatasetStorage } from "../../src/twin/datasetStorage.js";

describe("dataset hashing", () => {
  it("stores content addressed output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtis-"));
    try { const stored = await new LocalFilesystemDatasetStorage(directory).store("hello"); expect(stored.hash).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"); expect(await readFile(new URL(stored.uri), "utf8")).toBe("hello"); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});
