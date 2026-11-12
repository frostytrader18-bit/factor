import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  applyTradeResult,
  isTradingSessionStopped,
  type TradingSession,
} from "../lib/trading-session";
import {
  applyMartingaleResult,
  getMartingaleProgress,
  getMartingaleStake,
  type MartingaleConfiguration,
  type MartingaleStrategy,
} from "../lib/martingale";

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

type SignalTradeRequest = {
  accountId: string;
  contractType: "match-digit" | "differ" | "over" | "under" | "even-odd";
  signalKey: string;
  marketSymbol: string;
  digit: number | null;
  stake: number;
  durationTicks: number;
  martingaleEnabled: boolean;
  strategy: MartingaleStrategy;
  martingaleFactor: number | null;
  takeProfit: number;
  stopLoss: number;
};

const activeTradeAccounts = new Set<string>();
const tradingSessions = new Map<string, TradingSession>();

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

function parseSignalTradeRequest(value: unknown): SignalTradeRequest | null {
  if (!isRecord(value)) return null;
  const contractType = value["contractType"];
  const signalKey = value["signalKey"];
  const marketSymbol = value["marketSymbol"];
  const digit = value["digit"];
  const accountId = value["accountId"];
  const stake = value["stake"];
  const durationTicks = value["durationTicks"];
  const martingaleEnabled = value["martingaleEnabled"];
  const strategy = value["strategy"];
  const martingaleFactor = value["martingaleFactor"];
  const takeProfit = value["takeProfit"];
  const stopLoss = value["stopLoss"];
  if (
    typeof accountId !== "string" || accountId.length === 0 || accountId.length > 64
    || (contractType !== "match-digit" && contractType !== "differ"
      && contractType !== "over" && contractType !== "under"
      && contractType !== "even-odd")
    || typeof signalKey !== "string" || signalKey.length > 32
    || typeof marketSymbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(marketSymbol)
    || !(digit === null || (typeof digit === "number" && Number.isInteger(digit) && digit >= 0 && digit <= 9))
    || typeof stake !== "number" || !Number.isFinite(stake) || stake <= 0 || stake > 10000
    || typeof durationTicks !== "number" || !Number.isInteger(durationTicks)
    || durationTicks < 1 || durationTicks > 10
    || typeof martingaleEnabled !== "boolean"
    || (strategy !== 1 && strategy !== 2 && strategy !== 3)
    || !(martingaleFactor === null || (typeof martingaleFactor === "number"
      && Number.isFinite(martingaleFactor) && martingaleFactor >= 1 && martingaleFactor <= 100))
    || (martingaleEnabled && martingaleFactor === null)
    || typeof takeProfit !== "number" || !Number.isFinite(takeProfit) || takeProfit <= 0 || takeProfit > 1000000
    || typeof stopLoss !== "number" || !Number.isFinite(stopLoss) || stopLoss <= 0 || stopLoss > 1000000
  ) {
    return null;
  }

  if (contractType === "match-digit" || contractType === "differ") {
    if (digit === null || signalKey !== String(digit)) return null;
  } else if (contractType === "over" || contractType === "under") {
    if (digit === null || signalKey !== `${contractType}-${digit}`) return null;
  } else if (digit !== null || (signalKey !== "even" && signalKey !== "odd")) {
    return null;
  }

  return {
    accountId,
    contractType,
    signalKey,
    marketSymbol,
    digit,
    stake,
    durationTicks,
    martingaleEnabled,
    strategy,
    martingaleFactor,
    takeProfit,
    stopLoss,
  };
}

function getDerivContractParameters(trade: SignalTradeRequest, currency: string) {
  const contractType = trade.contractType === "match-digit"
    ? "DIGITMATCH"
    : trade.contractType === "differ"
      ? "DIGITDIFF"
      : trade.contractType === "over"
        ? "DIGITOVER"
        : trade.contractType === "under"
          ? "DIGITUNDER"
          : trade.signalKey === "even"
            ? "DIGITEVEN"
            : "DIGITODD";
  return {
    amount: trade.stake,
    basis: "stake",
    contract_type: contractType,
    currency,
    duration: trade.durationTicks,
    duration_unit: "t",
    underlying_symbol: trade.marketSymbol,
    ...(trade.digit === null ? {} : { barrier: String(trade.digit) }),
  };
}

type MarketTick = {
  symbol: string;
  epoch: number;
  quote: number;
  pipSize: number;
};

function parseMarketTick(value: unknown): MarketTick | null {
  if (!isRecord(value)) return null;
  const { symbol, epoch, quote, pip_size: pipSize } = value;
  if (
    typeof symbol !== "string"
    || !Number.isInteger(epoch)
    || typeof quote !== "number" || !Number.isFinite(quote)
    || !Number.isInteger(pipSize) || Number(pipSize) < 0 || Number(pipSize) > 10
  ) {
    return null;
  }
  return {
    symbol,
    epoch: Number(epoch),
    quote,
    pipSize: Number(pipSize),
  };
}

function getLastDigit(tick: MarketTick): number {
  const fixedQuote = tick.quote.toFixed(tick.pipSize);
  return Number(fixedQuote.replace(".", "").at(-1));
}

function didContractWin(trade: SignalTradeRequest, tick: MarketTick): boolean {
  const lastDigit = getLastDigit(tick);
  switch (trade.contractType) {
    case "match-digit":
      return lastDigit === trade.digit;
    case "differ":
      return lastDigit !== trade.digit;
    case "over":
      return lastDigit > (trade.digit ?? -1);
    case "under":
      return lastDigit < (trade.digit ?? 10);
    case "even-odd":
      return trade.signalKey === "even" ? lastDigit % 2 === 0 : lastDigit % 2 === 1;
  }
}

function waitForTickSettlement(
  socket: WebSocket,
  trade: SignalTradeRequest,
  expiryEpoch: number,
  payout: number,
  buyPrice: number,
  bufferedTicks: MarketTick[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (tick: MarketTick) => {
      cleanup();
      resolve(didContractWin(trade, tick) ? payout - buyPrice : -buyPrice);
    };
    const inspect = (tick: MarketTick) => {
      if (tick.symbol === trade.marketSymbol && tick.epoch >= expiryEpoch) {
        finish(tick);
        return true;
      }
      return false;
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The trade was placed, but Deriv's live feed did not confirm its expiry tick."));
    }, 60_000);
    const onMessage = (event: MessageEvent) => {
      const message = decodeSocketMessage(event);
      const tick = message && message["msg_type"] === "tick"
        ? parseMarketTick(message["tick"])
        : null;
      if (tick) inspect(tick);
    };
    const onError = () => {
      cleanup();
      reject(new Error("The trade was placed, but the live feed disconnected before its expiry tick."));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("The trade was placed, but the live feed closed before its expiry tick."));
    };
    for (const tick of bufferedTicks) {
      if (inspect(tick)) return;
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function decodeSocketMessage(event: MessageEvent): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(String(event.data));
    return isRecord(message) ? message : null;
  } catch (error) {
    logger.warn({ err: error }, "Deriv trade socket returned an invalid message");
    return null;
  }
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Deriv trade connection timed out."));
    }, 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to Deriv trading."));
    }, { once: true });
  });
}

function sendDerivRequest(
  socket: WebSocket,
  reqId: number,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Deriv did not respond to the trade request in time."));
    }, 10_000);
    const onMessage = (event: MessageEvent) => {
      const message = decodeSocketMessage(event);
      if (!message || message["req_id"] !== reqId) return;
      cleanup();
      if (isRecord(message["error"])) {
        const detail = message["error"]["message"];
        reject(new Error(typeof detail === "string" ? detail : "Deriv rejected the trade request."));
        return;
      }
      resolve(message);
    };
    const onError = () => {
      cleanup();
      reject(new Error("The Deriv trade connection failed."));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    try {
      socket.send(JSON.stringify({ ...request, req_id: reqId }));
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Could not send the trade request to Deriv."));
    }
  });
}

async function executeSignalTrade(
  accessToken: string,
  account: DerivAccountBalance,
  trade: SignalTradeRequest,
): Promise<{ contractId: string; profit: number }> {
  const socket = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
  let tradePlaced = false;
  const bufferedTicks: MarketTick[] = [];
  const bufferMarketTicks = (event: MessageEvent) => {
    const message = decodeSocketMessage(event);
    const tick = message && message["msg_type"] === "tick"
      ? parseMarketTick(message["tick"])
      : null;
    if (tick?.symbol === trade.marketSymbol) {
      bufferedTicks.push(tick);
    }
  };
  socket.addEventListener("message", bufferMarketTicks);
  try {
    await waitForSocketOpen(socket);
    const contractParameters = getDerivContractParameters(trade, account.currency);
    const proposalMessage = await sendDerivRequest(socket, 1, {
      proposal: 1,
      ...contractParameters,
    });
    if (!isRecord(proposalMessage["proposal"])) {
      throw new Error("Deriv did not return a valid contract quote.");
    }
    const proposal = proposalMessage["proposal"];
    const askPrice = proposal["ask_price"];
    const payout = proposal["payout"];
    const expiryEpoch = proposal["date_expiry"];
    if (
      typeof askPrice !== "number" || !Number.isFinite(askPrice)
      || askPrice <= 0 || askPrice > trade.stake
      || typeof payout !== "number" || !Number.isFinite(payout) || payout < askPrice
      || !Number.isInteger(expiryEpoch) || Number(expiryEpoch) <= Math.floor(Date.now() / 1000)
    ) {
      throw new Error("Deriv returned an invalid quote or expiry for the configured stake and duration.");
    }

    const tickSubscription = await sendDerivRequest(socket, 2, {
      ticks: trade.marketSymbol,
      subscribe: 1,
    });
    if (!parseMarketTick(tickSubscription["tick"])) {
      throw new Error("Deriv did not start the live market feed needed to confirm trade expiry.");
    }

    let purchaseResponse: globalThis.Response;
    try {
      purchaseResponse = await fetch(
        `https://api.derivws.com/trading/v1/options/contracts/bulk-purchase/${account.accountType}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Deriv-App-ID": APP_ID,
          },
          body: JSON.stringify({
            contract_parameters: contractParameters,
            accounts: [{ token: accessToken, account_id: account.accountId }],
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      throw Object.assign(
        new Error("Deriv order submission could not be confirmed. Check account transactions before re-arming."),
        { tradePlaced: true, cause: error },
      );
    }

    let purchasePayload: unknown;
    try {
      purchasePayload = await purchaseResponse.json();
    } catch (error) {
      if (purchaseResponse.ok || purchaseResponse.status >= 500) {
        throw Object.assign(
          new Error("Deriv's purchase response was incomplete. Check account transactions before re-arming."),
          { tradePlaced: true, cause: error },
        );
      }
      throw new Error(`Deriv rejected the purchase request with HTTP ${purchaseResponse.status}.`);
    }
    if (!purchaseResponse.ok) {
      const errorMessage = isRecord(purchasePayload)
        && Array.isArray(purchasePayload["errors"])
        && isRecord(purchasePayload["errors"][0])
        && typeof purchasePayload["errors"][0]["message"] === "string"
        ? purchasePayload["errors"][0]["message"]
        : `HTTP ${purchaseResponse.status}`;
      if (purchaseResponse.status >= 500) {
        throw Object.assign(
          new Error(`Deriv purchase status is uncertain (${errorMessage}). Check account transactions before re-arming.`),
          { tradePlaced: true },
        );
      }
      throw new Error(`Deriv rejected the purchase request: ${errorMessage}`);
    }

    const transactions = isRecord(purchasePayload)
      && isRecord(purchasePayload["data"])
      && Array.isArray(purchasePayload["data"]["transactions"])
      ? purchasePayload["data"]["transactions"]
      : null;
    if (!transactions) {
      throw Object.assign(
        new Error("Deriv returned an incomplete purchase result. Check account transactions before re-arming."),
        { tradePlaced: true },
      );
    }
    const transaction = transactions.find((item) => (
      isRecord(item) && item["account_id"] === account.accountId
    ));
    if (!isRecord(transaction)) {
      throw Object.assign(
        new Error("Deriv did not confirm the selected account's purchase. Check account transactions before re-arming."),
        { tradePlaced: true },
      );
    }
    if (isRecord(transaction["error"])) {
      const message = transaction["error"]["message"];
      throw new Error(typeof message === "string"
        ? `Deriv rejected the purchase: ${message}`
        : "Deriv rejected the purchase for the selected account.");
    }

    const contractId = transaction["contract_id"];
    const buyPrice = transaction["buy_price"];
    if (
      (typeof contractId !== "string" && typeof contractId !== "number")
      || typeof buyPrice !== "number" || !Number.isFinite(buyPrice)
      || buyPrice <= 0 || buyPrice > trade.stake
    ) {
      throw Object.assign(
        new Error("Deriv returned an invalid purchase receipt. Check account transactions before re-arming."),
        { tradePlaced: true },
      );
    }
    tradePlaced = true;

    const profit = await waitForTickSettlement(
      socket,
      trade,
      Number(expiryEpoch),
      payout,
      buyPrice,
      bufferedTicks,
    );
    return { contractId: String(contractId), profit };
  } catch (error) {
    if (tradePlaced) {
      throw Object.assign(
        error instanceof Error ? error : new Error("Deriv could not confirm the trade result."),
        { tradePlaced: true },
      );
    }
    throw error;
  } finally {
    socket.removeEventListener("message", bufferMarketTicks);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
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

router.post("/oauth/deriv/trading/execute", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const accessToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (!accessToken) {
    res.status(401).json({ error: "Connect a Deriv account before trading." });
    return;
  }

  const trade = parseSignalTradeRequest(req.body);
  if (!trade) {
    res.status(400).json({ error: "The signal trade settings are invalid." });
    return;
  }
  let accountsResponse: globalThis.Response;
  try {
    accountsResponse = await validateApiToken(accessToken);
  } catch (error) {
    logger.error({ err: error }, "Deriv trade account verification could not reach Deriv");
    res.status(503).json({ error: "Could not verify the Deriv account before trading." });
    return;
  }
  if (accountsResponse.status === 401 || accountsResponse.status === 403) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, cookieOptions("/api/oauth/deriv", 0));
    res.status(401).json({ error: "Deriv rejected this session. Reconnect before trading." });
    return;
  }
  if (!accountsResponse.ok) {
    logger.warn({ statusCode: accountsResponse.status }, "Deriv trade account verification failed");
    res.status(503).json({ error: "Could not verify the Deriv account before trading." });
    return;
  }

  let accountPayload: unknown;
  try {
    accountPayload = await accountsResponse.json();
  } catch (error) {
    logger.error({ err: error }, "Deriv returned invalid account data before trading");
    res.status(502).json({ error: "Deriv returned an invalid account list." });
    return;
  }
  const accounts = parseAccountBalances(accountPayload);
  if (!accounts) {
    logger.error(
      { responseKeys: isRecord(accountPayload) ? Object.keys(accountPayload) : [] },
      "Deriv returned an invalid account list before trading",
    );
    res.status(502).json({ error: "Deriv returned an invalid account list." });
    return;
  }
  const account = accounts.find((item) => item.accountId === trade.accountId);
  if (!account) {
    res.status(403).json({ error: "The selected Deriv account is not active or is not available to this session." });
    return;
  }
  const session = tradingSessions.get(account.accountId) ?? {
    profit: 0,
    stopped: false,
  };
  if (isTradingSessionStopped(session, trade.takeProfit, trade.stopLoss)) {
    tradingSessions.set(account.accountId, session);
    res.status(409).json({
      accountId: account.accountId,
      sessionStopped: true,
      sessionProfit: session.profit,
      error: "The configured session profit or loss limit has been reached. Reset this account's trading session before trading again.",
    });
    return;
  }

  const martingaleConfiguration: MartingaleConfiguration = {
    enabled: trade.martingaleEnabled,
    strategy: trade.strategy,
    factor: trade.martingaleFactor,
    baseStake: trade.stake,
  };
  const martingaleProgress = getMartingaleProgress(session.martingale, martingaleConfiguration);
  const currentStake = getMartingaleStake(martingaleProgress);
  if (currentStake > account.balance || currentStake > 10000) {
    res.status(400).json({
      error: "The martingale stake exceeds the selected account balance or the $10,000 safety cap. Reduce the base stake or martingale value.",
    });
    return;
  }
  session.martingale = martingaleProgress;

  if (activeTradeAccounts.has(account.accountId)) {
    res.status(409).json({ error: "A trade is already being processed for this account." });
    return;
  }
  activeTradeAccounts.add(account.accountId);
  try {
    const result = await executeSignalTrade(
      accessToken,
      account,
      { ...trade, stake: currentStake },
    );
    applyTradeResult(session, result.profit, trade.takeProfit, trade.stopLoss);
    session.martingale = applyMartingaleResult(
      martingaleProgress,
      martingaleConfiguration,
      currentStake,
      result.profit,
    );
    tradingSessions.set(account.accountId, session);
    res.status(200).json({
      ...result,
      accountId: account.accountId,
      stake: currentStake,
      nextStake: getMartingaleStake(session.martingale),
      sessionProfit: session.profit,
      sessionStopped: session.stopped,
    });
  } catch (error) {
    const tradePlaced = isRecord(error)
      && error["tradePlaced"] === true;
    if (tradePlaced) {
      logger.error({ err: error, contractId: "unconfirmed" }, "Deriv trade was placed but settlement could not be confirmed");
      res.status(502).json({
        tradePlaced: true,
        error: error instanceof Error
          ? error.message
          : "The trade was placed, but Deriv could not confirm its settlement.",
      });
      return;
    }
    logger.error({ err: error }, "Deriv rejected or failed to place the signal trade");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Deriv could not complete the signal trade.",
    });
  } finally {
    activeTradeAccounts.delete(account.accountId);
  }
});

router.get("/oauth/deriv/trading/session", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const accessToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (!accessToken) {
    res.status(401).json({ error: "Connect a Deriv account before checking its trading session." });
    return;
  }
  const accountId = req.query["accountId"];
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 64) {
    res.status(400).json({ error: "Select a valid Deriv account." });
    return;
  }

  try {
    const response = await validateApiToken(accessToken);
    if (!response.ok) {
      res.status(response.status === 401 || response.status === 403 ? 401 : 503)
        .json({ error: "Could not verify the Deriv account before checking its session." });
      return;
    }
    const accounts = parseAccountBalances(await response.json());
    const account = accounts?.find((item) => item.accountId === accountId);
    if (!account) {
      res.status(403).json({ error: "The selected Deriv account is not active or is not available to this session." });
      return;
    }
    const session = tradingSessions.get(account.accountId);
    res.status(200).json({
      accountId: account.accountId,
      sessionProfit: session?.profit ?? 0,
      sessionStopped: session?.stopped ?? false,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not verify the Deriv account before checking its trading session");
    res.status(503).json({ error: "Could not verify the Deriv account before checking its session." });
  }
});

router.post("/oauth/deriv/trading/session/reset", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const accessToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (!accessToken) {
    res.status(401).json({ error: "Connect a Deriv account before resetting its trading session." });
    return;
  }
  const accountId = req.body?.accountId;
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 64) {
    res.status(400).json({ error: "Select a valid Deriv account." });
    return;
  }

  try {
    const response = await validateApiToken(accessToken);
    if (!response.ok) {
      res.status(response.status === 401 || response.status === 403 ? 401 : 503)
        .json({ error: "Could not verify the Deriv account before resetting its session." });
      return;
    }
    const accounts = parseAccountBalances(await response.json());
    const account = accounts?.find((item) => item.accountId === accountId);
    if (!account) {
      res.status(403).json({ error: "The selected Deriv account is not active or is not available to this session." });
      return;
    }
    if (activeTradeAccounts.has(account.accountId)) {
      res.status(409).json({ error: "Wait for the current trade to settle before resetting the session." });
      return;
    }
    tradingSessions.delete(account.accountId);
    res.status(200).json({ accountId: account.accountId, sessionProfit: 0, sessionStopped: false });
  } catch (error) {
    logger.error({ err: error }, "Could not verify the Deriv account before resetting its trading session");
    res.status(503).json({ error: "Could not verify the Deriv account before resetting its session." });
  }
});

export default router;
