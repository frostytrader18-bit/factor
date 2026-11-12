import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  applyDemoTradeResult,
  isDemoTradingSessionStopped,
  type DemoTradingSession,
} from "../lib/demo-trading-session";
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
  martingaleEnabled: boolean;
  strategy: MartingaleStrategy;
  martingaleFactor: number | null;
  takeProfit: number;
  stopLoss: number;
  sessionProfit: number;
};

const activeTradeAccounts = new Set<string>();
const demoTradingSessions = new Map<string, DemoTradingSession>();

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
  const martingaleEnabled = value["martingaleEnabled"];
  const strategy = value["strategy"];
  const martingaleFactor = value["martingaleFactor"];
  const takeProfit = value["takeProfit"];
  const stopLoss = value["stopLoss"];
  const sessionProfit = value["sessionProfit"];
  if (
    typeof accountId !== "string" || accountId.length === 0 || accountId.length > 64
    || (contractType !== "match-digit" && contractType !== "differ"
      && contractType !== "over" && contractType !== "under"
      && contractType !== "even-odd")
    || typeof signalKey !== "string" || signalKey.length > 32
    || typeof marketSymbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(marketSymbol)
    || !(digit === null || (typeof digit === "number" && Number.isInteger(digit) && digit >= 0 && digit <= 9))
    || typeof stake !== "number" || !Number.isFinite(stake) || stake <= 0 || stake > 10000
    || typeof martingaleEnabled !== "boolean"
    || (strategy !== 1 && strategy !== 2 && strategy !== 3)
    || !(martingaleFactor === null || (typeof martingaleFactor === "number"
      && Number.isFinite(martingaleFactor) && martingaleFactor >= 1 && martingaleFactor <= 100))
    || (martingaleEnabled && martingaleFactor === null)
    || typeof takeProfit !== "number" || !Number.isFinite(takeProfit) || takeProfit <= 0 || takeProfit > 1000000
    || typeof stopLoss !== "number" || !Number.isFinite(stopLoss) || stopLoss <= 0 || stopLoss > 1000000
    || typeof sessionProfit !== "number" || !Number.isFinite(sessionProfit)
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
    martingaleEnabled,
    strategy,
    martingaleFactor,
    takeProfit,
    stopLoss,
    sessionProfit,
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
  const duration = trade.contractType === "match-digit" ? 3 : 1;
  return {
    proposal: 1,
    amount: trade.stake,
    basis: "stake",
    contract_type: contractType,
    currency,
    duration,
    duration_unit: "t",
    symbol: trade.marketSymbol,
    ...(trade.digit === null ? {} : { barrier: String(trade.digit) }),
  };
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

function waitForContractSettlement(
  socket: WebSocket,
  reqId: number,
  contractId: string | number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let subscriptionAccepted = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The trade was placed, but Deriv did not confirm its settlement in time."));
    }, 30_000);
    const onMessage = (event: MessageEvent) => {
      const message = decodeSocketMessage(event);
      if (!message) return;
      if (message["req_id"] === reqId) {
        if (isRecord(message["error"])) {
          cleanup();
          reject(new Error("The trade was placed, but Deriv could not provide its result."));
          return;
        }
        subscriptionAccepted = true;
      }
      if (message["msg_type"] !== "proposal_open_contract"
        || !isRecord(message["proposal_open_contract"])) return;
      const contract = message["proposal_open_contract"];
      if (String(contract["contract_id"]) !== String(contractId)) return;
      if (contract["is_sold"] === 1 || contract["is_sold"] === true) {
        cleanup();
        resolve(contract);
      } else if (subscriptionAccepted && message["error"]) {
        cleanup();
        reject(new Error("The trade was placed, but Deriv could not provide its result."));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("The trade was placed, but the result connection was interrupted."));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.send(JSON.stringify({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1,
      req_id: reqId,
    }));
  });
}

async function executeDemoSignalTrade(
  accessToken: string,
  account: DerivAccountBalance,
  trade: SignalTradeRequest,
): Promise<{ contractId: string; profit: number }> {
  const socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`);
  let tradePlaced = false;
  try {
    await waitForSocketOpen(socket);
    const authorized = await sendDerivRequest(socket, 1, { authorize: accessToken });
    if (!isRecord(authorized["authorize"])) {
      throw new Error("Deriv did not confirm account authorization.");
    }
    const accounts = authorized["authorize"]["account_list"];
    if (Array.isArray(accounts) && !accounts.some((item) => (
      isRecord(item) && item["loginid"] === account.accountId
    ))) {
      throw new Error("The selected demo account is not authorized for this session.");
    }

    const switched = await sendDerivRequest(socket, 2, {
      switch_account: 1,
      loginid: account.accountId,
    });
    if (
      !isRecord(switched["switch_account"])
      || switched["switch_account"]["loginid"] !== account.accountId
    ) {
      throw new Error("Deriv could not select the chosen demo account.");
    }

    const proposalMessage = await sendDerivRequest(
      socket,
      3,
      getDerivContractParameters(trade, account.currency),
    );
    if (!isRecord(proposalMessage["proposal"])) {
      throw new Error("Deriv did not return a valid contract quote.");
    }
    const proposal = proposalMessage["proposal"];
    const proposalId = proposal["id"];
    const askPrice = proposal["ask_price"];
    if (
      (typeof proposalId !== "string" && typeof proposalId !== "number")
      || typeof askPrice !== "number" || !Number.isFinite(askPrice)
      || askPrice <= 0 || askPrice > trade.stake
    ) {
      throw new Error("Deriv returned a quote that exceeds the configured stake.");
    }

    const buyMessage = await sendDerivRequest(socket, 4, {
      buy: proposalId,
      price: trade.stake,
    });
    if (!isRecord(buyMessage["buy"])) {
      throw new Error("Deriv did not confirm the contract purchase.");
    }
    const bought = buyMessage["buy"];
    const contractId = bought["contract_id"];
    if (typeof contractId !== "string" && typeof contractId !== "number") {
      throw new Error("Deriv confirmed the purchase without a contract ID.");
    }
    tradePlaced = true;

    const settlement = await waitForContractSettlement(socket, 5, contractId);
    const profit = settlement["profit"];
    if (typeof profit !== "number" || !Number.isFinite(profit)) {
      throw new Error("Deriv settled the trade without a valid profit result.");
    }
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
  if (!account || account.accountType !== "demo") {
    res.status(403).json({ error: "Automated signal trading is restricted to active Deriv demo accounts." });
    return;
  }
  const session = demoTradingSessions.get(account.accountId) ?? {
    profit: trade.sessionProfit,
    stopped: false,
  };
  if (isDemoTradingSessionStopped(session, trade.takeProfit, trade.stopLoss)) {
    demoTradingSessions.set(account.accountId, session);
    res.status(409).json({
      sessionStopped: true,
      sessionProfit: session.profit,
      error: "The configured session profit or loss limit has been reached. Reset the demo trading session before trading again.",
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
      error: "The martingale stake exceeds the selected demo account balance or the $10,000 safety cap. Reduce the base stake or martingale value.",
    });
    return;
  }
  session.martingale = martingaleProgress;

  if (activeTradeAccounts.has(account.accountId)) {
    res.status(409).json({ error: "A trade is already being processed for this demo account." });
    return;
  }
  activeTradeAccounts.add(account.accountId);
  try {
    const result = await executeDemoSignalTrade(
      accessToken,
      account,
      { ...trade, stake: currentStake },
    );
    applyDemoTradeResult(session, result.profit, trade.takeProfit, trade.stopLoss);
    session.martingale = applyMartingaleResult(
      martingaleProgress,
      martingaleConfiguration,
      currentStake,
      result.profit,
    );
    demoTradingSessions.set(account.accountId, session);
    res.status(200).json({
      ...result,
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

router.post("/oauth/deriv/trading/session/reset", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const accessToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (!accessToken) {
    res.status(401).json({ error: "Connect a Deriv account before resetting its trading session." });
    return;
  }
  const accountId = req.body?.accountId;
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 64) {
    res.status(400).json({ error: "Select a valid demo account." });
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
    if (!account || account.accountType !== "demo") {
      res.status(403).json({ error: "Automated signal trading sessions are restricted to active demo accounts." });
      return;
    }
    if (activeTradeAccounts.has(account.accountId)) {
      res.status(409).json({ error: "Wait for the current trade to settle before resetting the session." });
      return;
    }
    demoTradingSessions.delete(account.accountId);
    res.status(200).json({ sessionProfit: 0 });
  } catch (error) {
    logger.error({ err: error }, "Could not verify the Deriv account before resetting its trading session");
    res.status(503).json({ error: "Could not verify the Deriv account before resetting its session." });
  }
});

export default router;
