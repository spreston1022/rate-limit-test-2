import { jwks } from "./test-jwks";

/**
 * Stand-in IdP: publishes the public key that tokens from `npm run token`
 * are signed with. Point JWKS_URL at the real IdP and delete this route.
 */
export function jwksHandler() {
  return new Response(JSON.stringify(jwks), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
