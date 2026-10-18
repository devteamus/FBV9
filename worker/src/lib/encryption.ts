/**
 * AES-256-GCM encryption for Facebook Page access tokens.
 *
 * Uses Node.js native `crypto` (from `node:crypto`) — works reliably in
 * both dev and production standalone builds, unlike `globalThis.crypto.subtle`
 * which is missing/unreliable in some Node + standalone-build combinations.
 *
 * Key versioning is supported from day one: the ENCRYPTION_KEY env var
 * contains a base64-encoded 32-byte key. A version byte is prepended to
 * the ciphertext so keys can be rotated without losing existing data.
 *
 * Encrypted format: <version:1B> || <iv:12B> || <ciphertext> || <tag:16B>
 * All encoded as base64 for storage in Postgres TEXT column.
 */

import nodeCrypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const CURRENT_VERSION = 1;

function getKey(encKeyEnv: string): Buffer {
  const raw = Buffer.from(encKeyEnv, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes (base64-encoded). Got ${raw.length} bytes.`
    );
  }
  return raw;
}

export async function encrypt(plaintext: string): Promise<string> {
  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is not set — cannot encrypt account token."
    );
  }
  const key = getKey(keyEnv);
  const iv = nodeCrypto.randomBytes(IV_LENGTH);
  const cipher = nodeCrypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // result = version(1) || iv(12) || ciphertext || tag(16)
  const result = Buffer.alloc(1 + IV_LENGTH + ciphertext.length + TAG_LENGTH);
  result.writeUInt8(CURRENT_VERSION, 0);
  result.set(iv, 1);
  result.set(ciphertext, 1 + IV_LENGTH);
  result.set(tag, 1 + IV_LENGTH + ciphertext.length);

  return result.toString("base64");
}

export async function decrypt(encryptedB64: string): Promise<string> {
  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is not set — cannot decrypt account token."
    );
  }
  const key = getKey(keyEnv);
  const data = Buffer.from(encryptedB64, "base64");
  if (data.length < 1 + IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Invalid encrypted payload: too short");
  }
  const version = data.readUInt8(0);
  if (version !== CURRENT_VERSION) {
    throw new Error(`Unsupported encryption key version: ${version}`);
  }
  const iv = data.subarray(1, 1 + IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(1 + IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = nodeCrypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
