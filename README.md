# Rate Limiting Gateway

A Zuplo gateway that applies a warning threshold and a blocking threshold to
each API category, then forwards the request to the origin unchanged.

## Thresholds

| API category          | Path             | Warning          | Blocking           | Counted   |
| --------------------- | ---------------- | ---------------- | ------------------ | --------- |
| Login (test values; spec is 20 / 100) | `/login` | 2 / min | 5 / min | all users |
| Authentication APIs   | `/api/auth/*`    | 30 / min         | 150 / min          | all users |
| OAuth token           | `/oauth/token`   | 10 / min         | 50 / min           | all users |
| Public REST APIs      | `/api/restapi/*` | 60 / sec         | 100 / sec          | per user  |
| GraphQL APIs          | `/api/graphql`   | 60 / sec         | 100 / sec          | per user  |
| Data MS REST APIs     | `/data/rest/*`   | 60 / sec         | 100 / sec          | per user  |
| MCP                   | `/mcp`           | 100 / min        | 500 / min          | per user  |
| MCP                   | `/mcp`           | 500 / min        | 1,000 / min        | all users |
| Default / other paths | `/*`             | 100 / min        | 500 / min          | all users |

- **Blocking** returns `429 Too Many Requests` with a `Retry-After` header.
- **Warning** never blocks. The request goes through, a warning is written to
  the gateway log, and the response carries an `x-ratelimit-warning` header.

## How it is built

- `scripts/generate-config.mjs` holds the table above and generates
  `config/policies.json` and `config/routes.oas.json`. Change a threshold
  there and run `npm run generate`.
- `modules/rate-limits.ts` has the two pieces of custom code: `userKey`
  (who a per-user limit is counted against) and `warn` (the non-blocking
  warning threshold).
- `/mcp` requires a valid bearer token. The per-user API routes accept a
  bearer token or Basic auth, so the token is validated when present and
  Basic credentials pass through to the origin.

Per-user limits are counted against the `user_id` claim of the validated
bearer token. A request without that claim (no token, or Basic auth) is
counted against its client IP instead.

## Assumptions and open questions

1. **Warning behaviour** is assumed to be a log entry plus a response header.
2. **The first four rows** are assumed to be aggregate limits across all
   callers, not per user or per IP.
3. **Per-second limits** are enforced over a 6 second window (100/sec is
   600 per 6 seconds). Zuplo recommends windows of 5 seconds or longer for
   consistent enforcement across edge locations; a true 1 second window is
   `timeWindowMinutes: 0.0167` if stricter burst control is wanted.
4. **Basic auth requests** carry no `user_id` claim, so on the per-user
   routes they are limited by client IP. Whether those routes should require
   a bearer token instead is open.
5. **Origin and IdP** are placeholders until the real values are known.

## Configuration

| Variable         | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `ORIGIN_URL`     | Backend that every route forwards to. Defaults to `https://echo.zuplo.io` when unset |

Set it in the Zuplo Portal under Settings > Environment Variables for
deployed environments, and in `.env` locally (`cp .env.example .env`).

The token issuer and JWKS URL are constants at the top of
`scripts/generate-config.mjs`. They currently point at the stand-in IdP.

## Testing

```sh
npm install
npm run dev

# Aggregate limit: warnings start after 10 requests, 429 after 50
for i in $(seq 1 55); do curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9000/oauth/token; done

# Per-user limit with a test token
TOKEN=$(npm run -s token -- --user alice)
curl -i -X POST localhost:9000/mcp -H "authorization: Bearer $TOKEN"
```

`npm run token` signs tokens with a local test key and the gateway serves the
matching public key at `/.well-known/jwks.json`. This stands in for the real
IdP: once `JWKS_URL` and `JWT_ISSUER` in the generator point at it, delete that route,
`modules/test-idp.ts`, `modules/test-jwks.ts` and `tests/token.mjs`. The
private key lives in `tests/.keys` and is not committed, so tokens can only be
minted on the machine that generated it.
