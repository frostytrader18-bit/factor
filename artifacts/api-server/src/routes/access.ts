import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { parseAccessKeyHashes, verifyAccessKey } from "../lib/access-engine";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const COOKIE_NAME = "app_access";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const attemptsByClient = new Map<string, { count: number; resetAt: number }>();

function sessionSecret(): Buffer | null {
  const value = process.env.APP_ACCESS_SESSION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) return null;
  return Buffer.from(value, "utf8");
}

function sign(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAccessSession(secret: Buffer, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function isValidAccessSession(token: string | undefined, secret: Buffer, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("expiresAt" in parsed)) return false;
    const expiresAt = parsed.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now;
  } catch {
    return false;
  }
}

function getCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === COOKIE_NAME) return parts.join("=");
  }
  return undefined;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function isAccessConfigured(): boolean {
  return sessionSecret() !== null && parseAccessKeyHashes(process.env.APP_ACCESS_KEY_HASHES) !== null;
}

export function hasValidAccess(req: Request): boolean {
  const secret = sessionSecret();
  return secret !== null && isValidAccessSession(getCookie(req), secret);
}

router.get("/access/session", (req, res) => {
  const secret = sessionSecret();
  const keys = parseAccessKeyHashes(process.env.APP_ACCESS_KEY_HASHES);
  if (!secret) {
    res.status(503).json({ error: "App access is not configured on the server." });
    return;
  }
  if (!keys) {
    res.status(503).json({ error: "App access keys are not configured correctly." });
    return;
  }
  const authenticated = isValidAccessSession(getCookie(req), secret);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(authenticated ? 200 : 401).json({ authenticated });
});

router.post("/access/unlock", async (req, res) => {
  const secret = sessionSecret();
  const keys = parseAccessKeyHashes(process.env.APP_ACCESS_KEY_HASHES);
  if (!secret || !keys) {
    res.status(503).json({ error: "App access is not configured on the server." });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");

  const now = Date.now();
  const key = clientKey(req);
  for (const [client, limit] of attemptsByClient) {
    if (limit.resetAt <= now) attemptsByClient.delete(client);
  }
  if (!attemptsByClient.has(key) && attemptsByClient.size >= 5000) {
    res.status(429).json({ error: "Access verification is temporarily busy. Try again shortly." });
    return;
  }
  const attempt = attemptsByClient.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= MAX_ATTEMPTS) {
    res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    return;
  }
  if (!attempt || attempt.resetAt <= now) {
    attemptsByClient.set(key, { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }

  const password = req.body?.password;
  if (typeof password !== "string") {
    res.status(400).json({ error: "Access key could not be verified." });
    return;
  }

  const currentAttempt = attemptsByClient.get(key);
  if (!currentAttempt) {
    res.status(503).json({ error: "Access verification could not start. Try again shortly." });
    return;
  }
  currentAttempt.count += 1;

  const matches = await verifyAccessKey(password, keys);
  if (!matches) {
    logger.warn("App access key rejected");
    res.status(401).json({ error: "That access key is not valid." });
    return;
  }

  attemptsByClient.delete(key);
  res.cookie(COOKIE_NAME, createAccessSession(secret), {
    ...cookieOptions(),
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  res.json({ authenticated: true });
});

router.post("/access/lock", (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.status(204).end();
});

export default router;
