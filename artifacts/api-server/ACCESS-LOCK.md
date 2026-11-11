# App access lock

The production site is served through the API service. Keep that routing in place: the Express service verifies the signed session before returning the app HTML or any built asset. The standalone Vite development server is not a security boundary.

Configure these server-only environment variables:

- `APP_ACCESS_KEY_HASHES`: exactly seven `salt:hash` entries separated by semicolons. Each salt is base64url-encoded random data of at least 16 bytes; each hash is a 64-byte scrypt result, also base64url-encoded.
- `APP_ACCESS_SESSION_SECRET`: a randomly generated secret with at least 32 bytes.

Do not put plaintext access keys or the session secret in source control, frontend variables, or browser storage. Set them in the hosting provider's server-side environment settings. The server fails closed if either value is missing or malformed. Successful logins use a persistent 30-day cookie session, so closing and reopening the app does not log the user out. Sessions expire after 30 days or when explicitly locked; users may also be logged out if browser cookies are cleared. Access attempts are limited to five per client IP per 15 minutes per server process.

## Local development

From the repository root, run `corepack pnpm --filter @workspace/api-server run setup:access`. Enter the same seven access keys you intend to use; input is hidden. The command writes only scrypt hashes and a session secret to the ignored `artifacts/api-server/.env.local` file and refuses to overwrite an existing file.

Start the API with `corepack pnpm --filter @workspace/api-server run dev`, then start the frontend with `corepack pnpm --filter @workspace/deriv-analysis run dev`. The Vite proxy sends `/api` requests to the local API on port 5001. Use the same `APP_ACCESS_KEY_HASHES` value in every deployment environment to make the same keys work there; configure a separate `APP_ACCESS_SESSION_SECRET` in each environment.

The in-memory attempt limit is a basic safeguard, not a distributed rate limiter. For internet-facing production use, also enable the hosting provider's WAF/rate limiting and protect the deployment origins so requests cannot bypass the routed API service. A user who has already accessed the app can still save or inspect files delivered to their browser; no browser-based lock can prevent that.
