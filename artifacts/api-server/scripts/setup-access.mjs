import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scrypt = promisify(scryptCallback);
const input = process.stdin;
const output = process.stdout;
const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));

function readHidden(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run this setup command in an interactive terminal so keys are not echoed.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Access-key setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };

    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const keys = [];
  for (let index = 1; index <= 7; index += 1) {
    const key = await readHidden(`Access key ${index}/7 (input hidden): `);
    if (!key || keys.includes(key)) {
      throw new Error("Access keys must be non-empty and unique. No configuration was written.");
    }
    keys.push(key);
  }

  const entries = [];
  for (const key of keys) {
    const salt = randomBytes(16);
    const hash = await scrypt(key, salt, 64);
    entries.push(`${salt.toString("base64url")}:${hash.toString("base64url")}`);
  }

  const contents = [
    "NODE_ENV=development",
    "PORT=5001",
    `APP_ACCESS_KEY_HASHES=${entries.join(";")}`,
    `APP_ACCESS_SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
    "",
  ].join("\n");
  const file = await open(envPath, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
  } finally {
    await file.close();
  }

  output.write(`Saved access-key hashes and a session secret to ${path.relative(process.cwd(), envPath)}.\n`);
  output.write("Plaintext keys were not saved. Keep this file private and configure APP_ACCESS_KEY_HASHES in each deployment environment.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Access-key setup failed.");
  process.exitCode = 1;
});
