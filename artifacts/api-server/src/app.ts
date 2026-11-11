import express, { type Express } from "express";
import path from "node:path";
import cors from "cors";
import pinoHttp from "pino-http";
import { fileURLToPath } from "node:url";
import { hasValidAccess, isAccessConfigured } from "./routes/access";
import router from "./routes";
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
app.use(express.json({ limit: "4kb" }));
app.use(express.urlencoded({ extended: true, limit: "4kb" }));

app.use("/api", router);

app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    next();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).end();
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (!isAccessConfigured()) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.status(503).type("html").send("<!doctype html><title>Access unavailable</title><p>App access is not configured. Access remains locked.</p>");
    return;
  }
  if (!hasValidAccess(req)) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>ONE-MARKET · Locked</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#071620;color:#dce6ef;font:15px system-ui,sans-serif}
main{width:min(100%,390px);padding:28px;border:1px solid #236b72;border-radius:18px;background:linear-gradient(135deg,#0c2831,#101b24);box-shadow:0 20px 70px #0006}
h1{margin:0;color:#f2f0e9;font-size:20px;letter-spacing:.1em}p{color:#9bb8bc;font-size:13px}label{display:block;margin:22px 0 8px;color:#c2d6d8;font-size:12px;font-weight:700}
input,button{width:100%;height:46px;border-radius:9px}input{border:1px solid #315761;background:#071a23;padding:0 13px;color:white;font:16px monospace;letter-spacing:.18em}
button{margin-top:14px;border:1px solid #22a89a;background:linear-gradient(90deg,#087b83,#136a91);color:white;font-weight:800;letter-spacing:.12em;cursor:pointer}
#message{min-height:18px;color:#ffaaa0;font-size:12px}button:disabled{opacity:.55;cursor:wait}
</style></head>
<body><main><h1>ONE-MARKET</h1><p>LOCKED · ACCESS KEY REQUIRED</p>
<form id="unlock"><label for="key">Enter your access key</label>
<input id="key" name="password" type="password" autocomplete="off" autocapitalize="off" required>
<button id="submit" type="submit">UNLOCK APP</button><div id="message" role="alert"></div></form></main>
<script>
const form=document.getElementById("unlock"),key=document.getElementById("key"),button=document.getElementById("submit"),message=document.getElementById("message");
const clearOfflineCopy=async()=>{
  try{
    if("serviceWorker"in navigator){
      const registrations=await navigator.serviceWorker.getRegistrations();
      const removed=await Promise.all(registrations.map(registration=>registration.unregister()));
      if(removed.some(success=>!success))throw new Error("Unable to unregister an offline app worker.");
    }
    if("caches"in window){
      const names=await caches.keys();
      const removed=await Promise.all(names.filter(name=>name.startsWith("one-market-shell-")||name.startsWith("d-pulse-shell-")).map(name=>caches.delete(name)));
      if(removed.some(success=>!success))throw new Error("Unable to clear an offline app cache.");
    }
    return true;
  }catch{
    message.textContent="Could not clear offline app data. Stay online and reload before unlocking.";
    return false;
  }
};
button.disabled=true;
const offlineCleanup=clearOfflineCopy().then(ready=>{button.disabled=!ready;return ready});
form.addEventListener("submit",async event=>{
  event.preventDefault();
  if(!(await offlineCleanup))return;
  button.disabled=true;message.textContent="";
  try{
    const response=await fetch("/api/access/unlock",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:key.value})});
    if(response.ok){location.replace("/");return}
    const result=await response.json();message.textContent=result.error||"Access denied.";
  }catch{
    message.textContent="Secure access is unavailable. Try again later.";
  }finally{
    button.disabled=false;
  }
});
</script></body></html>`);
    return;
  }
  next();
});

app.use(express.static(publicDir, {
  index: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  },
}));

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  res.sendFile(appIndexPath, (error) => {
    if (error) next(error);
  });
});

export default app;
