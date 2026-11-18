import {
  environment,
  type CustomRateLimitDetails,
  type ZuploContext,
  type ZuploRequest,
} from "@zuplo/runtime";

// Names are configurable so they can be matched to the real IdP and API
// without a code change.
const USER_CLAIM = environment.USER_CLAIM ?? "user_id";
const USER_ID_HEADER = environment.USER_ID_HEADER ?? "userId";
const TENANT_HEADER = environment.TENANT_HEADER ?? "x-prime-tenant";

function basicUsername(request: ZuploRequest): string | undefined {
  const [scheme, value] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !value) return undefined;
  try {
    return atob(value).split(":")[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bucket key for the per-user limits. In order of preference:
 *   1. the user claim of a validated bearer token (falls back to `sub`)
 *   2. the user id header, scoped to the tenant
 *   3. the Basic auth username, scoped to the tenant
 *   4. the client IP, so unidentified callers are still limited
 *
 * The gateway does not verify Basic credentials (the origin does), so 2 and 3
 * are only as trustworthy as the caller. See README "Open questions".
 */
export function userKey(
  request: ZuploRequest,
  context: ZuploContext,
  policyName: string,
): CustomRateLimitDetails {
  const claims = (request.user?.data ?? {}) as Record<string, unknown>;
  const claim = claims[USER_CLAIM] ?? request.user?.sub;
  if (typeof claim === "string" && claim) return { key: `user:${claim}` };

  const tenant = request.headers.get(TENANT_HEADER) ?? "-";
  const headerUser = request.headers.get(USER_ID_HEADER);
  if (headerUser) return { key: `header:${tenant}:${headerUser}` };

  const basicUser = basicUsername(request);
  if (basicUser) return { key: `basic:${tenant}:${basicUser}` };

  const ip = request.headers.get("true-client-ip") ?? "unknown";
  context.log.warn(`${policyName}: no user identity on request, limiting by IP`);
  return { key: `ip:${ip}` };
}

interface WarnOptions {
  /** Name of the rate-limit-inbound policy that counts toward the warning. */
  policy: string;
  /** Human-readable threshold, used in the log entry and response header. */
  threshold: string;
}

/**
 * Warning threshold. Runs a rate limit policy but never blocks: when the
 * limit is exceeded the request continues, a warning is logged and the
 * response carries an `x-ratelimit-warning` header.
 */
export async function warn(
  request: ZuploRequest,
  context: ZuploContext,
  options: WarnOptions,
  policyName: string,
) {
  const result = await context.invokeInboundPolicy(options.policy, request);
  if (!(result instanceof Response)) return result;
  if (result.status !== 429) return result;

  context.log.warn({
    message: "Rate limit warning threshold exceeded",
    policy: policyName,
    threshold: options.threshold,
    path: new URL(request.url).pathname,
    user: request.user?.sub,
  });
  context.addResponseSendingHook((response) => {
    const withWarning = new Response(response.body, response);
    withWarning.headers.append(
      "x-ratelimit-warning",
      `${policyName}; threshold="${options.threshold}"`,
    );
    return withWarning;
  });
  return request;
}
