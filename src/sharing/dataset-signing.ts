import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, open, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import canonicalize from 'canonicalize';

export const DATASET_SIGNING_DOMAIN = 'ObjectID signed dataset manifest v2\n';
export type DatasetSignerOptions = { keyFile: string; issuer: string; network: string };
export type DatasetSigningIdentity = { issuer: string; network: string; algorithm: 'Ed25519'; keyId: string; publicKey: string; createdAt: string; status: 'active' };

/** Dedicated server signing key. Never uses the owner's or the requesting DID's key. */
export class DatasetSigner {
  private loaded?: Promise<{ key: KeyObject; identity: DatasetSigningIdentity }>;
  constructor(private options: DatasetSignerOptions) {}
  private load() {
    if (!this.loaded) this.loaded = this.initialize().catch(error => { this.loaded = undefined; throw error; });
    return this.loaded;
  }
  private async initialize() {
    const issuer = this.options.issuer.replace(/\/$/, ''), network = this.options.network;
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['testnet', 'mainnet'].includes(network)) throw Error('Invalid dataset signing identity configuration');
    let stored: any;
    try { stored = JSON.parse(await readFile(this.options.keyFile, 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw Error('Dataset signing key unavailable or invalid');
      await mkdir(dirname(this.options.keyFile), { recursive: true, mode: 0o700 });
      const pair = generateKeyPairSync('ed25519');
      const record = { version: 1, issuer, network, createdAt: new Date().toISOString(), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      // Publish a fully written file without replacing an existing key in a race.
      const temp = `${this.options.keyFile}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close();
        try { await link(temp, this.options.keyFile); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
      } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
      stored = JSON.parse(await readFile(this.options.keyFile, 'utf8'));
    }
    if (stored.version !== 1 || stored.issuer !== issuer || stored.network !== network || !Number.isFinite(Date.parse(stored.createdAt))) throw Error('Dataset signing key identity mismatch');
    const key = createPrivateKey(stored.privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw Error('Dataset signing key must use Ed25519');
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const identity: DatasetSigningIdentity = { issuer, network, algorithm: 'Ed25519', publicKey: der.toString('base64'), keyId: `sha256:${createHash('sha256').update(der).digest('hex')}`, createdAt: stored.createdAt, status: 'active' };
    return { key, identity };
  }
  async publicIdentity() { return { ...(await this.load()).identity }; }
  async signManifest(manifest: Record<string, any>) {
    const { key, identity } = await this.load();
    if (manifest.format !== 'objectid.shared-dataset-manifest.v2' || manifest.network !== identity.network || manifest.signature) throw Error('Invalid manifest signing context');
    const signature = { type: 'ObjectIDIntegrationServerSignature', algorithm: 'Ed25519', canonicalization: 'RFC8785-JCS', purpose: 'dataset-export',
      issuer: identity.issuer, network: identity.network, keyId: identity.keyId, publicKey: identity.publicKey, createdAt: manifest.generatedAt };
    const unsigned = { ...manifest, signature };
    const value = sign(null, Buffer.from(DATASET_SIGNING_DOMAIN + canonicalize(unsigned)), key).toString('base64');
    return { ...manifest, signature: { ...signature, value } };
  }
}
