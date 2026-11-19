#!/usr/bin/env node
// Generates config/policies.json and config/routes.oas.json from the
// threshold table below. Edit the table, then run `npm run generate`.
import { writeFileSync } from "node:fs";

// Per-second limits are enforced over a 6 second window (100/sec = 600 per
// 6s): Zuplo recommends windows of 5s or longer for consistent enforcement.
const SEC = { minutes: 0.1, factor: 6, unit: "sec" };
const MIN = { minutes: 1, factor: 1, unit: "min" };

const ALL = ["get", "post", "put", "patch", "delete", "head", "options"];
const REST = ["get", "post", "put", "patch", "delete"];

// Order matters: routes match top to bottom, so the catch-all goes last.
const tiers = [
  { id: "login", label: "Login", path: "/login", methods: ["post"], warn: 2, block: 5, window: MIN }, // TEMP: lowered for testing (spec: warn 20, block 100),
  { id: "auth", label: "Authentication APIs", path: "/api/auth/(.*)", methods: REST, warn: 30, block: 150, window: MIN },
  { id: "oauth-token", label: "OAuth token", path: "/oauth/token", methods: ["post"], warn: 10, block: 50, window: MIN },
  { id: "restapi", label: "Public REST APIs", path: "/api/restapi/(.*)", methods: REST, warn: 60, block: 100, window: SEC, perUser: true, jwt: "optional" },
  { id: "graphql", label: "GraphQL APIs", path: "/api/graphql", methods: ["get", "post"], warn: 60, block: 100, window: SEC, perUser: true, jwt: "optional" },
  { id: "data-rest", label: "Data MS REST APIs", path: "/data/rest/(.*)", methods: REST, warn: 60, block: 100, window: SEC, perUser: true, jwt: "optional" },
  {
    id: "mcp", label: "MCP", path: "/mcp", methods: ["get", "post", "delete"], jwt: "required",
    limits: [
      { id: "mcp-user", warn: 100, block: 500, window: MIN, perUser: true },
      { id: "mcp-total", warn: 500, block: 1000, window: MIN },
    ],
  },
  { id: "default", label: "Default / other paths", path: "/(.*)", methods: ALL, warn: 100, block: 500, window: MIN },
];

// Placeholders until the real values are known. Tokens are minted by
// `npm run token` and verified with the public key this gateway serves.
const ORIGIN_URL = "https://echo.zuplo.io";
const JWT_ISSUER = "https://test-idp.rate-limit-test.local";
const JWKS_URL =
  "https://rate-limit-test-2-main-d5e669e.oracle-poc.zuplo.work/.well-known/jwks.json";

const identifier = { module: "$import(./modules/rate-limits)", export: "userKey" };

const jwtPolicy = (name, allowUnauthenticatedRequests) => ({
  name,
  policyType: "open-id-jwt-auth-inbound",
  handler: {
    module: "$import(@zuplo/runtime)",
    export: "OpenIdJwtInboundPolicy",
    options: {
      issuer: JWT_ISSUER,
      jwkUrl: JWKS_URL,
      allowUnauthenticatedRequests,
    },
  },
});

const rateLimit = (name, limit, requests, headerMode) => ({
  name,
  policyType: "rate-limit-inbound",
  handler: {
    module: "$import(@zuplo/runtime)",
    export: "RateLimitInboundPolicy",
    options: {
      rateLimitBy: limit.perUser ? "function" : "all",
      requestsAllowed: requests * limit.window.factor,
      timeWindowMinutes: limit.window.minutes,
      ...(limit.perUser ? { identifier } : {}),
      headerMode,
    },
  },
});

const describe = (limit, requests) =>
  `${requests} requests/${limit.window.unit}${limit.perUser ? "/user" : " total"}`;

const policies = [jwtPolicy("jwt-required", false), jwtPolicy("jwt-optional", true)];
const paths = {};

for (const tier of tiers) {
  const limits = tier.limits ?? [{ ...tier }];
  const inbound = tier.jwt ? [`jwt-${tier.jwt}`] : [];
  const warns = [];
  const blocks = [];

  for (const limit of limits) {
    policies.push(
      rateLimit(`${limit.id}-warn-counter`, limit, limit.warn, "none"),
      {
        name: `${limit.id}-warn`,
        policyType: "custom-code-inbound",
        handler: {
          module: "$import(./modules/rate-limits)",
          export: "warn",
          options: { policy: `${limit.id}-warn-counter`, threshold: describe(limit, limit.warn) },
        },
      },
      rateLimit(`${limit.id}-block`, limit, limit.block, "retry-after"),
    );
    warns.push(`${limit.id}-warn`);
    blocks.push(`${limit.id}-block`);
  }
  // Warnings run first so they count all traffic, including blocked requests.
  inbound.push(...warns, ...blocks);

  const summary = limits
    .map((l) => `warn at ${describe(l, l.warn)}, block at ${describe(l, l.block)}`)
    .join("; ");
  const item = { "x-zuplo-path": { pathMode: "url-pattern" } };
  for (const method of tier.methods) {
    item[method] = {
      summary: tier.label,
      description: `Rate limits: ${summary}.`,
      operationId: `${tier.id}-${method}`,
      tags: [tier.label],
      responses: {
        default: { description: "Response from the origin" },
        429: { description: "Blocking threshold exceeded" },
      },
      "x-zuplo-route": {
        corsPolicy: "none",
        handler: {
          module: "$import(@zuplo/runtime)",
          export: "urlForwardHandler",
          options: { baseUrl: ORIGIN_URL },
        },
        policies: { inbound },
      },
    };
  }
  paths[tier.path] = item;
}

// Stand-in IdP for demos. Delete once JWKS_URL points at the real IdP.
const jwksRoute = {
  "/.well-known/jwks.json": {
    "x-zuplo-path": { pathMode: "open-api" },
    get: {
      summary: "Test JWKS",
      description: "Public key for tokens minted by `npm run token`. Demo only.",
      operationId: "test-jwks",
      tags: ["Test"],
      responses: { 200: { description: "JWKS" } },
      "x-zuplo-route": {
        corsPolicy: "none",
        handler: { module: "$import(./modules/test-idp)", export: "jwksHandler" },
        policies: { inbound: [] },
      },
    },
  },
};

const oas = {
  openapi: "3.1.0",
  info: {
    version: "1.0.0",
    title: "Rate Limiting Gateway",
    description:
      "Warning and blocking rate limit thresholds per API category. Requests are forwarded to the origin unchanged.",
  },
  paths: { ...jwksRoute, ...paths },
};

const write = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
write("config/policies.json", { policies });
write("config/routes.oas.json", oas);
console.log(`Wrote ${policies.length} policies and ${Object.keys(oas.paths).length} paths.`);
