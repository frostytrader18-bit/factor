import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

const APP_ID = requiredEnv("DERIV_APP_ID");
const CALLBACK_URL = requiredEnv("DERIV_REDIRECT_URI");
const AUTHORIZATION_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const STATE_COOKIE = "pulsefactor_deriv_oauth";
const ACCESS_TOKEN_COOKIE = "pulsefactor_deriv_session";
export const DERIV_CALLBACK_PATH = new URL(CALLBACK_URL).pathname;
const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000;

const router = Router();

function cookieOptions(path: string, maxAge?: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const item of cookieHeader.split(";")) {
    const [cookieName, ...parts] = item.trim().split("=");
    if (cookieName !== name) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch (error) {
      logger.warn({ err: error }, "Malformed Deriv OAuth cookie");
      return undefined;
    }
  }
  return undefined;
}

function redirectWithError(res: Response, error: string): void {
  res.redirect(303, `/?deriv_oauth_error=${encodeURIComponent(error)}`);
}

function matchesState(returned: string, expected: string): boolean {
  const actualBytes = Buffer.from(returned);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type DerivAccountBalance = {
  accountId: string;
  accountType: "demo" | "real";
  balance: number;
  currency: string;
};

function getAccountRows(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload) || depth >= 3) return null;
  return getAccountRows(payload["data"] ?? payload["accounts"], depth + 1);
}

function parseAccountBalances(payload: unknown): DerivAccountBalance[] | null {
  const rows = getAccountRows(payload);
  if (!rows) return null;

  const accounts: DerivAccountBalance[] = [];
  for (const account of rows) {
    if (!isRecord(account)) continue;
    if (account["status"] === "inactive") continue;
    if (account["status"] !== undefined && account["status"] !== "active") continue;
    const accountId = account["account_id"] ?? account["accountId"];
    const accountType = account["account_type"] ?? account["accountType"];
    const rawBalance = account["balance"];
    const balance = typeof rawBalance === "number"
      ? rawBalance
      : typeof rawBalance === "string" && rawBalance.trim() !== ""
        ? Number(rawBalance)
        : Number.NaN;
    const currency = account["currency"];
    if (
      typeof accountId !== "string"
      || accountId.length === 0
      || accountId.length > 64
      || (accountType !== "demo" && accountType !== "real")
      || !Number.isFinite(balance)
      || balance < 0
      || typeof currency !== "string"
      || currency.length > 20
    ) {
      continue;
    }
    accounts.push({ accountId, accountType, balance, currency });
  }
  if (rows.length > 0 && accounts.length === 0) {
    return null;
  }
  return accounts;
}

async function validateApiToken(token: string): Promise<globalThis.Response> {
  return fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Deriv-App-ID": APP_ID,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

router.get("/oauth/deriv/login", (_req, res) => {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(AUTHORIZATION_URL);

  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", APP_ID);
  authorizationUrl.searchParams.set("redirect_uri", CALLBACK_URL);
  authorizationUrl.searchParams.set("scope", "trade");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  res.setHeader("Cache-Control", "no-store");
  res.cookie(STATE_COOKIE, `${state}.${verifier}`, cookieOptions(DERIV_CALLBACK_PATH, OAUTH_COOKIE_TTL_MS));
  res.redirect(302, authorizationUrl.toString());
});

router.post("/oauth/deriv/token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const token = req.body?.token;
  if (
    typeof token !== "string"
    || token.length === 0
    || Buffer.byteLength(token, "utf8") > 8192
    || token.trim() !== token
  ) {
    res.status(400).json({ error: "Enter a valid Deriv API token." });
    return;
  }

  let response: globalThis.Response;
  try {
    response = await validateApiToken(token);
  } catch (error) {
    logger.error({ err: error }, "Deriv API token verification could not reach Deriv");
    res.status(503).json({ error: "Could not verify the token with Deriv. Try again shortly." });
    return;
  }

  if (response.status === 401 || response.status === 403) {
    res.status(401).json({ error: "Deriv rejected this token. Check it and its account access, then try again." });
    return;
  }
  if (!response.ok) {
    logger.warn({ statusCode: response.status }, "Deriv API token verification failed");
    res.status(503).json({ error: "Deriv could not verify the token right now. Try again shortly." });
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    logger.error({ err: error }, "Deriv API token verification returned invalid account data");
    res.status(502).json({ error: "Deriv returned an invalid account list." });
    return;
  }
  const accounts = parseAccountBalances(payload);
  if (!accounts) {
    logger.error(
      { responseKeys: isRecord(payload) ? Object.keys(payload) : [] },
      "Deriv API token verification returned an invalid account list",
    );
    res.status(502).json({ error: "Deriv returned an invalid account list." });
    return;
  }

  res.cookie(ACCESS_TOKEN_COOKIE, token, cookieOptions("/api/oauth/deriv"));
  res.status(200).json({ authenticated: true, accounts });
});

export async function handleDerivOAuthCallback(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  const stateCookie = getCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, cookieOptions(DERIV_CALLBACK_PATH, 0));
  const [cookieState, verifier, extra] = stateCookie?.split(".") ?? [];
  const returnedState = req.query["state"];
  if (
    !cookieState
    || !verifier
    || extra !== undefined
    || typeof returnedState !== "string"
    || !matchesState(returnedState, cookieState)
  ) {
    redirectWithError(res, "invalid_state");
    return;
  }

  if (typeof req.query["error"] === "string") {
    const error = req.query["error"];
    redirectWithError(
      res,
      error === "invalid_scope"
        ? "invalid_scope"
        : error === "access_denied"
          ? "authorization_denied"
          : "authorization_failed",
    );
    return;
  }

  const code = req.query["code"];
  if (typeof code !== "string" || code.length === 0 || code.length > 4096) {
    redirectWithError(res, "invalid_callback");
    return;
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: APP_ID,
    code,
    redirect_uri: CALLBACK_URL,
    code_verifier: verifier,
  });

  let tokenResponse: unknown;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ statusCode: response.status }, "Deriv OAuth token exchange was rejected");
      redirectWithError(res, "token_exchange_failed");
      return;
    }
    tokenResponse = await response.json();
  } catch (error) {
    logger.error({ err: error }, "Deriv OAuth token exchange failed");
    redirectWithError(res, "token_exchange_failed");
    return;
  }

  if (!isRecord(tokenResponse)) {
    logger.error("Deriv OAuth token exchange returned an invalid response");
    redirectWithError(res, "token_exchange_failed");
    return;
  }

  const accessToken = tokenResponse["access_token"];
  const expiresIn = tokenResponse["expires_in"];
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || accessToken.length > 8192
    || typeof expiresIn !== "number"
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
  ) {
    logger.error("Deriv OAuth token exchange returned invalid credentials");
    redirectWithError(res, "token_exchange_failed");
    return;
  }

  const maxAge = Math.floor(expiresIn * 1000);
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, cookieOptions("/api/oauth/deriv", maxAge));
  res.redirect(303, "/");
}

router.get("/oauth/deriv/session", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const accessToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (!accessToken) {
    res.status(401).json({ authenticated: false });
    return;
  }

  try {
    const response = await validateApiToken(accessToken);
    if (response.status === 401 || response.status === 403) {
      res.clearCookie(ACCESS_TOKEN_COOKIE, cookieOptions("/api/oauth/deriv", 0));
      if (response.status === 403) {
        res.status(403).json({
          authenticated: false,
          error: "Deriv account access is not enabled. Reconnect and approve the trade permission.",
        });
        return;
      }
      res.status(401).json({ authenticated: false });
      return;
    }
    if (!response.ok) {
      logger.warn({ statusCode: response.status }, "Deriv session verification failed");
      res.status(503).json({ error: "Deriv login status is temporarily unavailable." });
      return;
    }
    const payload: unknown = await response.json();
    const accounts = parseAccountBalances(payload);
    if (!accounts) {
      logger.error(
        { responseKeys: isRecord(payload) ? Object.keys(payload) : [] },
        "Deriv accounts response did not contain a valid account list",
      );
      res.status(502).json({ error: "Deriv returned an invalid account list." });
      return;
    }

    res.status(200).json({ authenticated: true, accounts });
    return;
  } catch (error) {
    logger.error({ err: error }, "Deriv session verification could not reach Deriv");
    res.status(503).json({ error: "Deriv login status is temporarily unavailable." });
    return;
  }

});

router.delete("/oauth/deriv/session", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.clearCookie(ACCESS_TOKEN_COOKIE, cookieOptions("/api/oauth/deriv", 0));
  res.status(204).end();
});

export default router;
