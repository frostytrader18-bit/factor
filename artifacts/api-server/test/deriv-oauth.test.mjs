import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test, { after } from "node:test";

process.env.NODE_ENV = "test";
process.env.DERIV_APP_ID = "34VWBd5pBISkAMEF3Zxm7";
process.env.DERIV_REDIRECT_URI = "https://pulsefactor.space";

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

test("Deriv login uses PKCE and exchanges the callback code server-side", async () => {
  const anonymousSession = await fetch(`${baseUrl}/api/oauth/deriv/session`);
  assert.equal(anonymousSession.status, 401);

  const nativeFetch = globalThis.fetch;
  let tokenRequest;
  let accountsRequest;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://api.derivws.com") {
      accountsRequest = { url, headers: init?.headers };
      return new Response(JSON.stringify({
        data: [
          { account_id: "CR12345", balance: 123.45, currency: "USD", group: "demo", status: "active", account_type: "demo" },
          { account_id: "CR54321", balance: 0, currency: "USD", group: "real", status: "inactive", account_type: "real" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.origin === "https://auth.deriv.com") {
      tokenRequest = {
        url,
        method: init?.method,
        headers: init?.headers,
        body: new URLSearchParams(init?.body),
      };
      return new Response(JSON.stringify({
        access_token: "test-deriv-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return nativeFetch(input, init);
  };

  try {
    const login = await nativeFetch(`${baseUrl}/api/oauth/deriv/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const authorization = new URL(login.headers.get("location"));
    const state = authorization.searchParams.get("state");
    const verifierCookie = login.headers.get("set-cookie");
    assert.ok(state);
    assert.ok(verifierCookie);
    assert.match(verifierCookie, /HttpOnly/i);
    assert.match(verifierCookie, /SameSite=Lax/i);
    assert.match(verifierCookie, /Path=\//i);

    const [cookieState, verifier] = decodeURIComponent(verifierCookie.split(";")[0].split("=")[1]).split(".");
    assert.equal(cookieState, state);
    assert.equal(
      authorization.searchParams.get("code_challenge"),
      createHash("sha256").update(verifier).digest("base64url"),
    );

    const callback = await nativeFetch(
      `${baseUrl}/?code=one-time-code&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: verifierCookie.split(";")[0] },
        redirect: "manual",
      },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/");
    assert.equal(tokenRequest?.url.href, "https://auth.deriv.com/oauth2/token");
    assert.equal(tokenRequest?.method, "POST");
    assert.match(tokenRequest?.headers?.["Content-Type"] ?? tokenRequest?.headers?.["content-type"] ?? "", /application\/x-www-form-urlencoded/);
    assert.equal(tokenRequest?.body.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest?.body.get("client_id"), "34VWBd5pBISkAMEF3Zxm7");
    assert.equal(tokenRequest?.body.get("code"), "one-time-code");
    assert.equal(tokenRequest?.body.get("redirect_uri"), "https://pulsefactor.space");
    assert.equal(tokenRequest?.body.get("code_verifier"), verifier);

    const cookies = callback.headers.getSetCookie();
    const sessionCookie = cookies.find((cookie) => cookie.startsWith("pulsefactor_deriv_session="));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Path=\/api\/oauth\/deriv/i);
    assert.doesNotMatch(callback.headers.get("location") ?? "", /access_token|one-time-code/);

    const session = await nativeFetch(`${baseUrl}/api/oauth/deriv/session`, {
      headers: { cookie: sessionCookie.split(";")[0] },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      authenticated: true,
      accounts: [{ accountType: "demo", balance: 123.45, currency: "USD" }],
    });
    assert.equal(accountsRequest?.url.href, "https://api.derivws.com/trading/v1/options/accounts");
    assert.equal(accountsRequest?.headers?.Authorization, "Bearer test-deriv-access-token");
    assert.equal(accountsRequest?.headers?.["Deriv-App-ID"], "34VWBd5pBISkAMEF3Zxm7");

    const logout = await nativeFetch(`${baseUrl}/api/oauth/deriv/session`, {
      method: "DELETE",
      headers: { cookie: sessionCookie.split(";")[0] },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.getSetCookie().join(";"), /Expires=Thu, 01 Jan 1970/);
    const loggedOutSession = await nativeFetch(`${baseUrl}/api/oauth/deriv/session`);
    assert.equal(loggedOutSession.status, 401);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("Deriv API-token login validates tokens and stores valid credentials in an HttpOnly cookie", async () => {
  const nativeFetch = globalThis.fetch;
  const submittedToken = "test-deriv-personal-token";
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.derivws.com") return nativeFetch(input, init);

    requests.push({ url, headers: init?.headers });
    const authorization = new Headers(init?.headers).get("Authorization");
    return new Response(JSON.stringify({
      data: [
        { account_id: "CR12345", balance: 123.45, currency: "USD", group: "demo", status: "active", account_type: "demo" },
      ],
    }), {
      status: authorization === `Bearer ${submittedToken}` ? 200 : 401,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const invalid = await nativeFetch(`${baseUrl}/api/oauth/deriv/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invalid-token" }),
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.getSetCookie().length, 0);

    const connected = await nativeFetch(`${baseUrl}/api/oauth/deriv/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: submittedToken }),
    });
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), {
      authenticated: true,
      accounts: [{ accountType: "demo", balance: 123.45, currency: "USD" }],
    });
    assert.equal(connected.headers.get("cache-control"), "no-store");
    const cookie = connected.headers.getSetCookie()
      .find((value) => value.startsWith("pulsefactor_deriv_session="));
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/api\/oauth\/deriv/i);
    assert.doesNotMatch(cookie, /Secure/i);

    const session = await nativeFetch(`${baseUrl}/api/oauth/deriv/session`, {
      headers: { cookie: cookie.split(";")[0] },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      authenticated: true,
      accounts: [{ accountType: "demo", balance: 123.45, currency: "USD" }],
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url.href, "https://api.derivws.com/trading/v1/options/accounts");
    assert.equal(requests[1].headers["Deriv-App-ID"], "34VWBd5pBISkAMEF3Zxm7");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("Deriv API-token login rejects malformed and oversized token submissions", async () => {
  for (const token of ["", " token ", "x".repeat(8193)]) {
    const response = await fetch(`${baseUrl}/api/oauth/deriv/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Enter a valid Deriv API token." });
  }
});

test("Deriv callback rejects state mismatches without exchanging a code", async () => {
  const login = await fetch(`${baseUrl}/api/oauth/deriv/login`, { redirect: "manual" });
  const stateCookie = login.headers.get("set-cookie");
  assert.ok(stateCookie);

  const callback = await fetch(
    `${baseUrl}/?code=one-time-code&state=wrong-state`,
    {
      headers: { cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location") ?? "", /deriv_oauth_error=invalid_state/);
});

test("Deriv callback reports when the OAuth app lacks the requested trade scope", async () => {
  const login = await fetch(`${baseUrl}/api/oauth/deriv/login`, { redirect: "manual" });
  const stateCookie = login.headers.get("set-cookie");
  assert.ok(stateCookie);
  const [state] = decodeURIComponent(stateCookie.split(";")[0].split("=")[1]).split(".");

  const callback = await fetch(
    `${baseUrl}/?error=invalid_scope&state=${encodeURIComponent(state)}`,
    {
      headers: { cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location") ?? "", /deriv_oauth_error=invalid_scope/);
});
