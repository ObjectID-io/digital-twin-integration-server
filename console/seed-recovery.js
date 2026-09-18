function b64url(bytes) {
  let binary = "";
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function aesKey(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

function fromB64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function generateSeedHex() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function buildSeedRecoveryFile({ seed, password, hint, did }) {
  const normalized = String(seed).trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error("Seed must contain 64 hexadecimal characters");
  if (!password) throw new Error("Recovery password is required");
  if (!String(hint).trim()) throw new Error("Password hint is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(normalized)));
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "none" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    v: 1, hint: String(hint).trim(), it: 150_000, s: b64url(salt), iv: b64url(iv), ct: b64url(encrypted), ts: Date.now(),
  })));
  return { v: 2, hint: String(hint).trim(), jwt: `${header}.${payload}.`, createdAt: new Date().toISOString(), dids: did ? [did] : [] };
}

export function downloadRecoveryFile(recovery, did) {
  const objectId = String(did).split(":").pop() || "identity";
  const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `objectid-recovery-${objectId.slice(0, 12)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function parseRecoveryFile(text) {
  const value = JSON.parse(String(text));
  if (value?.v !== 2 || !value.jwt || !value.hint) throw new Error("This is not a valid ObjectID recovery file");
  return { hint: String(value.hint), jwt: String(value.jwt), did: Array.isArray(value.dids) ? String(value.dids[0] ?? "") : "" };
}

export async function decryptRecoveryFile(recovery, password) {
  if (!password) throw new Error("Recovery password is required");
  const parts = String(recovery.jwt).split(".");
  if (parts.length < 2) throw new Error("Recovery token is invalid");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  if (Number(payload.it) < 10_000) throw new Error("Recovery token parameters are invalid");
  const key = await aesKey(password, fromB64url(payload.s));
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(payload.iv) }, key, fromB64url(payload.ct));
    const seed = new TextDecoder().decode(decrypted).trim();
    if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error("Decrypted seed is invalid");
    return seed;
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Decrypted seed is invalid") throw cause;
    throw new Error("Wrong password or corrupted recovery file");
  }
}
