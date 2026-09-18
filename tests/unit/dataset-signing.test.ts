import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicKey, verify } from 'node:crypto';
import canonicalize from 'canonicalize';
import { DatasetSigner, DATASET_SIGNING_DOMAIN } from '../../src/sharing/dataset-signing.js';
const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
describe.each(['testnet', 'mainnet'])('dataset server signatures on %s', network => {
  async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'dataset-signature-')); directories.push(directory); return { keyFile: join(directory, 'keys', 'signing.json'), issuer: 'https://is.example' + (network === 'mainnet' ? '/mainnet' : ''), network }; }
  it('persists a dedicated key across instances and signs manifest plus signer metadata', async () => {
    const options = await fixture(), signer = new DatasetSigner(options);
    const manifest = { format: 'objectid.shared-dataset-manifest.v2', network, generatedAt: new Date().toISOString(), ownerDid: 'not-the-signer', files: [{ sha256: 'a'.repeat(64) }] };
    const signed = await signer.signManifest(manifest), identity = await signer.publicIdentity();
    const { value, ...metadata } = signed.signature;
    const key = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), type: 'spki', format: 'der' });
    expect(verify(null, Buffer.from(DATASET_SIGNING_DOMAIN + canonicalize({ ...signed, signature: metadata })), key, Buffer.from(value, 'base64'))).toBe(true);
    expect(verify(null, Buffer.from(DATASET_SIGNING_DOMAIN + canonicalize({ ...signed, ownerDid: 'changed', signature: metadata })), key, Buffer.from(value, 'base64'))).toBe(false);
    expect(verify(null, Buffer.from(DATASET_SIGNING_DOMAIN + canonicalize({ ...signed, signature: { ...metadata, issuer: 'https://other.example' } })), key, Buffer.from(value, 'base64'))).toBe(false);
    expect(await new DatasetSigner(options).publicIdentity()).toEqual(identity);
    expect(JSON.stringify(signed)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(identity)).not.toContain('PRIVATE KEY');
    await expect(signer.signManifest({ ...manifest, network: 'wrong' })).rejects.toThrow(/context/);
  });
  it('concurrent initialization converges on one key, and invalid or mismatched keys are never replaced', async () => {
    const options = await fixture(); const identities = await Promise.all([new DatasetSigner(options).publicIdentity(), new DatasetSigner(options).publicIdentity()]);
    expect(identities[0]).toEqual(identities[1]);
    const before = await readFile(options.keyFile, 'utf8');
    await expect(new DatasetSigner({ ...options, issuer: 'https://different.example' }).publicIdentity()).rejects.toThrow(/mismatch/);
    expect(await readFile(options.keyFile, 'utf8')).toBe(before);
    await writeFile(options.keyFile, 'broken'); await expect(new DatasetSigner(options).publicIdentity()).rejects.toThrow(/invalid/);
    expect(await readFile(options.keyFile, 'utf8')).toBe('broken');
  });
});
