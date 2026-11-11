import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export type AccessKeyHash = {
  salt: Buffer;
  hash: Buffer;
};

export function parseAccessKeyHashes(raw: string | undefined): AccessKeyHash[] | null {
  if (!raw) return null;

  const entries: AccessKeyHash[] = [];
  for (const entry of raw.split(";")) {
    const [saltText, hashText, extra] = entry.split(":");
    if (
      !saltText
      || !hashText
      || extra !== undefined
      || !/^[A-Za-z0-9_-]+$/.test(saltText)
      || !/^[A-Za-z0-9_-]+$/.test(hashText)
    ) {
      return null;
    }

    const salt = Buffer.from(saltText, "base64url");
    const hash = Buffer.from(hashText, "base64url");
    if (
      salt.length < 16
      || salt.toString("base64url") !== saltText
      || hash.length !== 64
      || hash.toString("base64url") !== hashText
    ) {
      return null;
    }
    entries.push({ salt, hash });
  }

  return entries.length === 7 ? entries : null;
}

export async function verifyAccessKey(
  candidate: string,
  configuredHashes: readonly AccessKeyHash[],
): Promise<boolean> {
  let matches = false;
  for (const { salt, hash } of configuredHashes) {
    const derived = await scrypt(candidate, salt, hash.length) as Buffer;
    matches = timingSafeEqual(derived, hash) || matches;
  }
  return matches;
}
