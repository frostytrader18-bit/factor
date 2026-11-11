import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import test, { after } from "node:test";

const keys = [
  "aBC123!@#$",
  "dEF456%^&*",
  "gHI789-_+=",
  "jKL!2@3#4$",
  "mNO%5^6&7*",
  "pQR_8+9=0!",
  "sTU-1?2$3%",
];
process.env.NODE_ENV = "test";
process.env.APP_ACCESS_SESSION_SECRET = randomBytes(48).toString("base64url");
process.env.APP_ACCESS_KEY_HASHES = keys.map((key) => {
  const salt = randomBytes(16);
  return `${salt.toString("base64url")}:${scryptSync(key, salt, 64).toString("base64url")}`;
}).join(";");

const { default: app } = await import("../dist/index.mjs");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("access keys protect the app, assets, and unlock session", async () => {
  const indexHtml = await readFile(new URL("../dist/public/index.html", import.meta.url), "utf8");
  const appScript = indexHtml.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(appScript);

  const lockedPage = await fetch(baseUrl);
  const lockedHtml = await lockedPage.text();
  assert.equal(lockedPage.status, 200);
  assert.match(lockedHtml, /Enter your access key/);
  assert.doesNotMatch(lockedHtml, /type="module"/);

  const protectedAsset = await fetch(new URL(appScript, baseUrl));
  assert.match(await protectedAsset.text(), /Enter your access key/);
  assert.match(protectedAsset.headers.get("content-type") ?? "", /text\/html/);

  const wrongKey = await fetch(`${baseUrl}/api/access/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "AAAAAAAAAA" }),
  });
  assert.equal(wrongKey.status, 401);

  const shortKey = await fetch(`${baseUrl}/api/access/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "abc" }),
  });
  assert.equal(shortKey.status, 401);

  for (const [index, password] of keys.entries()) {
    const unlock = await fetch(`${baseUrl}/api/access/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(unlock.status, 200);
    const setCookie = unlock.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /Max-Age=2592000/i);
    const cookie = setCookie.split(";")[0];
    assert.ok(cookie);

    const session = await fetch(`${baseUrl}/api/access/session`, { headers: { cookie } });
    assert.equal(session.status, 200);

    const appPage = await fetch(baseUrl, { headers: { cookie } });
    assert.match(await appPage.text(), /type="module"/);

    if (index === 0) {
      const appAsset = await fetch(new URL(appScript, baseUrl), { headers: { cookie } });
      assert.match(appAsset.headers.get("content-type") ?? "", /javascript/);
    }

    const lock = await fetch(`${baseUrl}/api/access/lock`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(lock.status, 204);
    assert.match(lock.headers.get("set-cookie") ?? "", /Expires=Thu, 01 Jan 1970/);

    const loggedOut = await fetch(baseUrl);
    assert.match(await loggedOut.text(), /Enter your access key/);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/access/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "AAAAAAAAAA" }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/access/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "AAAAAAAAAA" }),
  });
  assert.equal(limited.status, 429);

  const validHashes = process.env.APP_ACCESS_KEY_HASHES;
  try {
    process.env.APP_ACCESS_KEY_HASHES = "malformed";
    const unavailableSession = await fetch(`${baseUrl}/api/access/session`);
    assert.equal(unavailableSession.status, 503);

    const unavailableUnlock = await fetch(`${baseUrl}/api/access/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: keys[0] }),
    });
    assert.equal(unavailableUnlock.status, 503);
    assert.equal(unavailableUnlock.headers.get("set-cookie"), null);
  } finally {
    if (validHashes === undefined) {
      delete process.env.APP_ACCESS_KEY_HASHES;
    } else {
      process.env.APP_ACCESS_KEY_HASHES = validHashes;
    }
  }
});
