#!/usr/bin/env node
// Prints a signed test JWT for the stand-in IdP (/.well-known/jwks.json).
//
//   npm run token -- --user alice
//   npm run token -- --user alice --hours 8
//
// The first run creates a signing key in tests/.keys (gitignored) and writes
// the matching public key to modules/test-jwks.ts, which must be deployed.
import { createSign, generateKeyPairSync, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const KEY = new URL("./.keys/private.pem", import.meta.url);
const KID = new URL("./.keys/kid", import.meta.url);
const JWKS = new URL("../modules/test-jwks.ts", import.meta.url);
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

if (!existsSync(KEY)) {
  mkdirSync(new URL("./.keys/", import.meta.url), { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `test-${randomBytes(4).toString("hex")}`;
  writeFileSync(KEY, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(KID, kid);
  const jwk = { ...createPublicKey(privateKey).export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  writeFileSync(
    JWKS,
    `// Public half of the test signing key (tests/.keys/private.pem). Safe to commit.\nexport const jwks = ${JSON.stringify({ keys: [jwk] }, null, 2)};\n`,
  );
  console.error("Created a new test signing key; redeploy so the gateway serves modules/test-jwks.ts.");
}

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "test-user" },
    hours: { type: "string", default: "1" },
    issuer: { type: "string", default: "https://test-idp.rate-limit-test.local" },
  },
});

const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT", kid: readFileSync(KID, "utf8").trim() };
const payload = {
  iss: values.issuer,
  sub: values.user,
  user_id: values.user,
  iat: now,
  exp: now + Math.round(Number(values.hours) * 3600),
};
const signingInput = `${b64(header)}.${b64(payload)}`;
const signature = createSign("RSA-SHA256").update(signingInput).sign(readFileSync(KEY)).toString("base64url");
const token = `${signingInput}.${signature}`;
// No trailing newline when piped, so it can go straight into a header.
process.stdout.write(process.stdout.isTTY ? `${token}\n` : token);
