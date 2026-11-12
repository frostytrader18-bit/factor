import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test, { after } from "node:test";

process.env.NODE_ENV = "test";
process.env.DERIV_APP_ID = "34VWBd5pBISkAMEF3Zxm7";
process.env.DERIV_REDIRECT_URI = "https://www.pulsefactor.space/oauth/callback";

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
      `${baseUrl}/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
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
    assert.equal(tokenRequest?.body.get("redirect_uri"), "https://www.pulsefactor.space/oauth/callback");
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
      accounts: [{ accountId: "CR12345", accountType: "demo", balance: 123.45, currency: "USD" }],
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
      accounts: [{ accountId: "CR12345", accountType: "demo", balance: 123.45, currency: "USD" }],
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
      accounts: [{ accountId: "CR12345", accountType: "demo", balance: 123.45, currency: "USD" }],
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url.href, "https://api.derivws.com/trading/v1/options/accounts");
    assert.equal(requests[1].headers["Deriv-App-ID"], "34VWBd5pBISkAMEF3Zxm7");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("signal trades use the selected real or demo account and keep independent account sessions", async () => {
  const body = {
    contractType: "match-digit",
    signalKey: "7",
    marketSymbol: "R_100",
    digit: 7,
    stake: 1,
    durationTicks: 1,
    martingaleEnabled: false,
    strategy: 1,
    martingaleFactor: null,
    takeProfit: 10,
    stopLoss: 5,
    sessionProfit: 999,
  };
  const nativeFetch = globalThis.fetch;
  const nativeWebSocket = globalThis.WebSocket;
  const websocketRequests = [];
  const websocketConnections = [];
  const otpRequests = [];
  const accounts = [
    { account_id: "CR-DEMO-54321", balance: 500, currency: "USD", status: "active", account_type: "demo" },
    { account_id: "CR-REAL-54321", balance: 500, currency: "USD", status: "active", account_type: "real" },
  ];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://api.derivws.com") {
      if (url.pathname.endsWith("/otp")) {
        otpRequests.push({ url, method: init.method, headers: init.headers });
        const accountType = url.pathname.endsWith("CR-DEMO-54321/otp") ? "demo" : "real";
        return new Response(JSON.stringify({
          data: { url: `wss://api.derivws.com/trading/v1/options/ws/${accountType}?otp=one-time-${accountType}` },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        data: accounts,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };

  class MockDerivWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      websocketConnections.push(String(url));
      this.readyState = MockDerivWebSocket.CONNECTING;
      this.accountType = new URL(url).pathname.endsWith("/demo") ? "demo" : "real";
      setTimeout(() => {
        this.readyState = MockDerivWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }, 0);
    }

    send(serializedRequest) {
      const request = JSON.parse(serializedRequest);
      websocketRequests.push(request);
      let response;
      if (request.proposal) {
        response = {
          req_id: request.req_id,
          proposal: { id: "proposal-id-12345678901234567890", ask_price: request.amount },
        };
      } else if (request.buy) {
        response = {
          req_id: request.req_id,
          buy: {
            contract_id: `contract-${this.accountType}`,
            buy_price: request.price,
          },
        };
      } else if (request.proposal_open_contract) {
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({
              req_id: request.req_id,
              msg_type: "proposal_open_contract",
              proposal_open_contract: {
                contract_id: `contract-${this.accountType}`,
                is_sold: 1,
                profit: this.accountType === "demo" ? 2 : -1,
              },
            }),
          }));
        }, 20);
        return;
      } else {
        throw new Error(`Unexpected Deriv public socket request: ${JSON.stringify(request)}`);
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify(response),
      })));
    }

    close() {
      this.readyState = MockDerivWebSocket.CLOSED;
    }
  }
  MockDerivWebSocket.CONNECTING = 0;
  MockDerivWebSocket.OPEN = 1;
  MockDerivWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockDerivWebSocket;

  try {
    const anonymous = await nativeFetch(`${baseUrl}/api/oauth/deriv/trading/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, accountId: "CR-REAL-54321" }),
    });
    assert.equal(anonymous.status, 401);
    const anonymousSession = await nativeFetch(
      `${baseUrl}/api/oauth/deriv/trading/session?accountId=CR-REAL-54321`,
    );
    assert.equal(anonymousSession.status, 401);

    for (const accountId of ["CR-DEMO-54321", "CR-REAL-54321"]) {
      const response = await nativeFetch(`${baseUrl}/api/oauth/deriv/trading/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pulsefactor_deriv_session=test-access-token",
        },
        body: JSON.stringify({
          ...body,
          accountId,
          durationTicks: accountId === "CR-DEMO-54321" ? 1 : 2,
        }),
      });
      assert.equal(response.status, 200);
      const expectedProfit = accountId === "CR-DEMO-54321" ? 2 : -1;
      assert.deepEqual(await response.json(), {
        contractId: `contract-${accountId === "CR-DEMO-54321" ? "demo" : "real"}`,
        profit: expectedProfit,
        accountId,
        stake: 1,
        nextStake: 1,
        sessionProfit: expectedProfit,
        sessionStopped: false,
      });
      const durationTicks = accountId === "CR-DEMO-54321" ? 1 : 2;
      const proposalRequest = websocketRequests.find((request) => (
        request.proposal === 1 && request.duration === durationTicks
      ));
      assert.ok(proposalRequest);
      assert.equal(proposalRequest.duration_unit, "t");
      assert.equal(proposalRequest.underlying_symbol, "R_100");
      assert.equal(proposalRequest.symbol, undefined);
      const buyRequest = websocketRequests.find((request) => request.buy);
      assert.equal(buyRequest.buy, "proposal-id-12345678901234567890");
      assert.equal(buyRequest.price, 1);
      const expectedAccountType = accountId === "CR-DEMO-54321" ? "demo" : "real";
      const settlementRequest = websocketRequests.find((request) => (
        request.proposal_open_contract === 1
        && request.contract_id === `contract-${expectedAccountType}`
      ));
      assert.ok(settlementRequest);
      const otpRequest = otpRequests.find((request) => (
        request.url.pathname.endsWith(`/accounts/${accountId}/otp`)
      ));
      assert.ok(otpRequest);
      assert.equal(otpRequest.method, "POST");
      assert.equal(otpRequest.headers.Authorization, "Bearer test-access-token");
      assert.equal(otpRequest.headers["Deriv-App-ID"], "34VWBd5pBISkAMEF3Zxm7");
      const socketUrl = new URL(websocketConnections.at(-1));
      assert.equal(socketUrl.pathname, `/trading/v1/options/ws/${expectedAccountType}`);
      assert.equal(socketUrl.searchParams.get("otp"), `one-time-${expectedAccountType}`);

      const session = await nativeFetch(
        `${baseUrl}/api/oauth/deriv/trading/session?accountId=${accountId}`,
        { headers: { cookie: "pulsefactor_deriv_session=test-access-token" } },
      );
      assert.equal(session.status, 200);
      assert.deepEqual(await session.json(), {
        accountId,
        sessionProfit: expectedProfit,
        sessionStopped: false,
      });
    }

    const unavailableAccount = await nativeFetch(
      `${baseUrl}/api/oauth/deriv/trading/session?accountId=CR-NOT-OWNED`,
      { headers: { cookie: "pulsefactor_deriv_session=test-access-token" } },
    );
    assert.equal(unavailableAccount.status, 403);

    const malformed = await nativeFetch(`${baseUrl}/api/oauth/deriv/trading/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "pulsefactor_deriv_session=test-access-token",
      },
      body: JSON.stringify({ ...body, accountId: "CR-REAL-54321", signalKey: "8" }),
    });
    assert.equal(malformed.status, 400);

    const invalidDuration = await nativeFetch(`${baseUrl}/api/oauth/deriv/trading/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "pulsefactor_deriv_session=test-access-token",
      },
      body: JSON.stringify({ ...body, accountId: "CR-REAL-54321", durationTicks: 0 }),
    });
    assert.equal(invalidDuration.status, 400);

    const resetReal = await nativeFetch(`${baseUrl}/api/oauth/deriv/trading/session/reset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "pulsefactor_deriv_session=test-access-token",
      },
      body: JSON.stringify({ accountId: "CR-REAL-54321" }),
    });
    assert.equal(resetReal.status, 200);
    assert.deepEqual(await resetReal.json(), {
      accountId: "CR-REAL-54321",
      sessionProfit: 0,
      sessionStopped: false,
    });
  } finally {
    globalThis.fetch = nativeFetch;
    globalThis.WebSocket = nativeWebSocket;
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

test("Deriv account parser accepts the accounts wrapper returned by API gateways", async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.derivws.com") return nativeFetch(input, init);
    return new Response(JSON.stringify({
      data: {
        accounts: [
          { account_id: "CR67890", balance: 98.76, currency: "", status: "active", account_type: "real" },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await nativeFetch(`${baseUrl}/api/oauth/deriv/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrapped-response-token" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true,
      accounts: [{ accountId: "CR67890", accountType: "real", balance: 98.76, currency: "" }],
    });
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("Deriv accounts response keeps active demo and real balances and ignores other rows", async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.derivws.com") return nativeFetch(input, init);
    return new Response(JSON.stringify({
      data: [
        { account_id: "CR-DEMO", account_type: "demo", balance: 10000, currency: "USD", group: "row", status: "active" },
        { account_id: "CR-REAL", account_type: "real", balance: 250.5, currency: "EUR", group: "row", status: "active" },
        { account_id: "CR-INACTIVE", account_type: "real", balance: 0, currency: "USD", group: "row", status: "inactive" },
        null,
      ],
      meta: { endpoint: "/trading/v1/options/accounts", method: "GET", timing: 20 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await nativeFetch(`${baseUrl}/api/oauth/deriv/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "multi-account-token" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true,
      accounts: [
        { accountId: "CR-DEMO", accountType: "demo", balance: 10000, currency: "USD" },
        { accountId: "CR-REAL", accountType: "real", balance: 250.5, currency: "EUR" },
      ],
    });
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("Deriv callback rejects state mismatches without exchanging a code", async () => {
  const login = await fetch(`${baseUrl}/api/oauth/deriv/login`, { redirect: "manual" });
  const stateCookie = login.headers.get("set-cookie");
  assert.ok(stateCookie);

  const callback = await fetch(
    `${baseUrl}/oauth/callback?code=one-time-code&state=wrong-state`,
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
    `${baseUrl}/oauth/callback?error=invalid_scope&state=${encodeURIComponent(state)}`,
    {
      headers: { cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location") ?? "", /deriv_oauth_error=invalid_scope/);
});
