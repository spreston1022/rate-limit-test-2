import {
  type CustomRateLimitDetails,
  type ZuploContext,
  type ZuploRequest,
} from "@zuplo/runtime";

const USER_CLAIM = "user_id";

/**
 * Bucket key for the per-user limits: the `user_id` claim of the validated
 * bearer token.
 *
 * Every per-user route requires a valid token, so the IP fallback below only
 * applies to a valid token that is missing the claim.
 */
export function userKey(
  request: ZuploRequest,
  context: ZuploContext,
  policyName: string,
): CustomRateLimitDetails {
  const claims = (request.user?.data ?? {}) as Record<string, unknown>;
  const userId = claims[USER_CLAIM];
  if (typeof userId === "string" || typeof userId === "number") {
    return { key: `user:${userId}` };
  }

  const ip = request.headers.get("true-client-ip") ?? "unknown";
  context.log.warn(`${policyName}: no ${USER_CLAIM} claim on request, limiting by IP`);
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
    user: request.user?.data?.[USER_CLAIM],
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
