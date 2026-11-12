import assert from "node:assert/strict";
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

test("app page and assets are publicly available without a login", async () => {
  const indexHtml = await fetch(baseUrl);
  const html = await indexHtml.text();
  assert.equal(indexHtml.status, 200);
  assert.equal(indexHtml.headers.get("cache-control"), "no-store");
  assert.match(html, /type="module"/);
  assert.match(html, /<title>PULSE-FACTOR<\/title>/);
  assert.match(html, /href="https:\/\/pulsefactor\.space\/"/);
  assert.match(html, /href="\/icons\/pulsefactor-192\.png"/);
  assert.doesNotMatch(html, /Enter your access key|UNLOCK APP/);

  const callbackPage = await fetch(`${baseUrl}/oauth/callback?code=example`, { redirect: "manual" });
  assert.equal(callbackPage.status, 303);
  assert.match(callbackPage.headers.get("location") ?? "", /deriv_oauth_error=invalid_state/);

  const oauthLogin = await fetch(`${baseUrl}/api/oauth/deriv/login`, { redirect: "manual" });
  assert.equal(oauthLogin.status, 302);
  const oauthUrl = new URL(oauthLogin.headers.get("location"));
  assert.equal(oauthUrl.origin, "https://auth.deriv.com");
  assert.equal(oauthUrl.pathname, "/oauth2/auth");
  assert.equal(oauthUrl.searchParams.get("client_id"), "34VWBd5pBISkAMEF3Zxm7");
  assert.equal(oauthUrl.searchParams.get("redirect_uri"), "https://www.pulsefactor.space/oauth/callback");
  assert.equal(oauthUrl.searchParams.get("response_type"), "code");
  assert.equal(oauthUrl.searchParams.get("scope"), "trade");
  assert.equal(oauthUrl.searchParams.get("code_challenge_method"), "S256");

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "PULSE-FACTOR");
  assert.equal(manifest.short_name, "PULSE-FACTOR");
  assert.equal(manifest.icons[0].src, "./icons/pulsefactor-192.png");
  assert.equal(manifest.icons[1].src, "./icons/pulsefactor-512.png");

  for (const assetPath of [
    "/pulsefactor-brand.png",
    "/icons/pulsefactor-192.png",
    "/icons/pulsefactor-512.png",
  ]) {
    const logo = await fetch(`${baseUrl}${assetPath}`);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type") ?? "", /image\/png/);
  }

  for (const obsoleteAsset of [
    "/favicon.svg",
    "/icons/d-pulse-192.png",
    "/icons/d-pulse-512.png",
    "/pulsefactor-wordmark.png",
  ]) {
    const response = await fetch(`${baseUrl}${obsoleteAsset}`);
    assert.equal(response.status, 404);
  }

  const appScript = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(appScript);
  const asset = await fetch(new URL(appScript, baseUrl));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  const bundle = await asset.text();
  for (const [staleAsset, currentAsset, contentType] of [
    ["/assets/index-from-old-deployment.js", appScript, /javascript/],
    ["/assets/index-from-old-deployment.css", html.match(/href="(\/assets\/index-[^"]+\.css)"/)?.[1], /text\/css/],
  ]) {
    assert.ok(currentAsset);
    const staleResponse = await fetch(`${baseUrl}${staleAsset}`, { redirect: "manual" });
    assert.equal(staleResponse.status, 307);
    assert.equal(staleResponse.headers.get("location"), currentAsset);
    assert.equal(staleResponse.headers.get("cache-control"), "no-store");

    const recoveredAsset = await fetch(`${baseUrl}${staleAsset}`);
    assert.equal(recoveredAsset.status, 200);
    assert.match(recoveredAsset.headers.get("content-type") ?? "", contentType);
  }

  assert.match(bundle, /PULSE-FACTOR/);
  assert.match(bundle, /\/icons\/pulsefactor-192\.png/);
  assert.match(bundle, /signal-trading-panel/);
  assert.match(bundle, /input-trading-stake/);
  assert.match(bundle, /button-clear-trading-values/);
  assert.match(bundle, /select-trading-multiplier-level/);
  assert.match(bundle, /DYNAMIC HYBRID/);
  assert.match(bundle, /toggle-martingale/);
  assert.match(bundle, /ARM DEMO AUTO-TRADING/);
  assert.match(bundle, /https:\/\/pulsefactor\.space\//);
  assert.match(bundle, /DERIV LOGIN/);
  assert.doesNotMatch(bundle, /button-api-token-login/);
  assert.match(bundle, /data-account-selector/);
  assert.match(bundle, /SWITCH ACCOUNT/);
  assert.match(bundle, /REAL ACCOUNT/);
  assert.match(bundle, /DEMO ACCOUNT/);
  assert.match(bundle, /status-deriv-balance/);
  assert.match(bundle, /text-deriv-balance/);
  assert.match(bundle, /CONNECT WITH API TOKEN/);
  assert.match(bundle, /api\/oauth\/deriv\/token/);
  assert.match(bundle, /SIGN UP/);
  assert.match(bundle, /api\/oauth\/deriv\/login/);
  assert.match(bundle, /api\/oauth\/deriv\/session/);
  assert.match(bundle, /t=439FPLA37FCH/);
  assert.doesNotMatch(bundle, /ONE-MARKET/);
});

test("API routes remain available and obsolete access routes are removed", async () => {
  const health = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const access = await fetch(`${baseUrl}/api/access/session`);
  assert.equal(access.status, 404);
});
