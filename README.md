# Rate Limiting Gateway

A Zuplo gateway that applies a warning threshold and a blocking threshold to
each API category, then forwards the request to the origin unchanged.

## Thresholds

| API category          | Path             | Warning          | Blocking           | Counted   |
| --------------------- | ---------------- | ---------------- | ------------------ | --------- |
| Login (test values; spec is 20 / 100) | `/login` | 2 / min | 5 / min | per user  |
| Authentication APIs   | `/api/auth/*`    | 30 / min         | 150 / min          | per user  |
| OAuth token           | `/oauth/token`   | 10 / min         | 50 / min           | per user  |
| Public REST APIs      | `/api/restapi/*` | 60 / sec         | 100 / sec          | per user  |
| GraphQL APIs          | `/api/graphql`   | 60 / sec         | 100 / sec          | per user  |
| Data MS REST APIs     | `/data/rest/*`   | 60 / sec         | 100 / sec          | per user  |
| MCP (test values; spec is 100 / 500) | `/mcp` | 3 / min | 5 / min | per user |
| MCP                   | `/mcp`           | 500 / min        | 1,000 / min        | all users |
| Default / other paths | `/*`             | 100 / min        | 500 / min          | per user  |

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
- Each route lists only the methods it needs: POST for `/login` and
  `/oauth/token`, GET and POST for `/api/graphql`, GET, POST and DELETE for
  `/mcp`, the five REST methods for the wildcard API routes, and everything
  for the catch-all. Any other method on those paths falls through to the
  catch-all and is handled under the default limits.
- Every route requires a valid bearer token. Requests without one get 401
  at the gateway, so every per-user limit is counted against a verified
  `user_id`.

Per-user limits are counted against the `user_id` claim of the validated
bearer token.

## Assumptions and open questions

1. **Warning behaviour** is assumed to be a log entry plus a response header.
2. **Every limit is per user** (`user_id` claim) except the `/mcp`
   "all users combined" row. This means `/login`, `/api/auth/*` and
   `/oauth/token` also require a token, which needs confirming since
   callers of those endpoints may not have one yet.
3. **Per-second limits** are enforced over a 6 second window (100/sec is
   600 per 6 seconds). Zuplo recommends windows of 5 seconds or longer for
   consistent enforcement across edge locations; a true 1 second window is
   `timeWindowMinutes: 0.0167` if stricter burst control is wanted.
4. **Basic auth is rejected** on every route, since a request
   without a validated token has no trustworthy user identity. The API is
   documented as also accepting Basic auth, so this needs confirming.
5. **Origin and IdP** are placeholders until the real values are known.

## Configuration

The origin, token issuer and JWKS URL are constants at the top of
`scripts/generate-config.mjs`. They are placeholders: the origin is an echo
service and the issuer is the stand-in IdP. Change them there and run
`npm run generate`.

## Testing

```sh
npm install
npm run dev

TOKEN=$(npm run -s token -- --user alice)

# Warnings start after 10 requests per user, 429 after 50
for i in $(seq 1 55); do curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9000/oauth/token -H "authorization: Bearer $TOKEN"; done

curl -i -X POST localhost:9000/mcp -H "authorization: Bearer $TOKEN"
```

`npm run token` signs tokens with a local test key and the gateway serves the
matching public key at `/.well-known/jwks.json`. This stands in for the real
IdP: once `JWKS_URL` and `JWT_ISSUER` in the generator point at it, delete that route,
`modules/test-idp.ts`, `modules/test-jwks.ts` and `tests/token.mjs`. The
private key lives in `tests/.keys` and is not committed, so tokens can only be
minted on the machine that generated it.
