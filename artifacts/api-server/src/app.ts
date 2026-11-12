import express, { type Express } from "express";
import path from "node:path";
import cors from "cors";
import pinoHttp from "pino-http";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { DERIV_CALLBACK_PATH, handleDerivOAuthCallback } from "./routes/deriv-oauth";
import { logger } from "./lib/logger";

const app: Express = express();
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const appIndexPath = path.join(publicDir, "index.html");
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self'; connect-src 'self' wss://api.derivws.com https://api.derivws.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "4kb" }));

app.use("/api", router);
app.get(DERIV_CALLBACK_PATH, (req, res, next) => {
  if (
    DERIV_CALLBACK_PATH === "/"
    && req.query["state"] === undefined
    && req.query["code"] === undefined
    && req.query["error"] === undefined
  ) {
    next();
    return;
  }
  void handleDerivOAuthCallback(req, res).catch(next);
});

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).end();
    return;
  }
  next();
});

app.use(express.static(publicDir, {
  index: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  },
}));

app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    res.status(404).end();
    return;
  }
  if (path.extname(req.path)) {
    res.status(404).end();
    return;
  }
  next();
});

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  res.sendFile(appIndexPath, (error) => {
    if (error) next(error);
  });
});

export default app;
