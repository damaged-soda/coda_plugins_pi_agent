import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPiFailure, isPiAuthError, getBase64DecodedSize } from "../agent/errors.mjs";

test("classifyPiFailure table cases", () => {
  const cases = [
    // Existing cases
    { input: "529 overloaded", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "503 Service Unavailable", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "fetch failed", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "terminated", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "429 Too Many Requests", expected: null },
    { input: "rate limit exceeded", expected: null },
    { input: "insufficient_quota", expected: { kind: "quota_exhausted" } },
    { input: "Your credit balance is too low to access the Anthropic API", expected: { kind: "quota_exhausted" } },
    { input: "403 You've reached your 5-hour usage limit.", expected: { kind: "quota_exhausted" } },
    { input: "401 Unauthorized", expected: null },
    { input: "prompt is too long: 250000 tokens > 200000 maximum", expected: null },
    { input: "429 quota exceeded", expected: { kind: "quota_exhausted" } },
    { input: "Bad request", expected: null },

    // Negative cases
    { input: "Invalid billing address", expected: null },
    { input: "max_tokens must be <= 500", expected: null },
    { input: "port 5002 in use", expected: null },
    { input: "config parse timeout", expected: null },
    { input: "Process terminated by user", expected: null },
    { input: "400 invalid_request_error: messages: field required", expected: null },
    { input: "422 validation failed", expected: null },
    { input: "Error: Invalid server error code in config", expected: null },

    // Positive cases
    { input: "timeout", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "Request timeout", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "The operation timed out", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "HTTP 503 from upstream", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "Error: 502 Bad Gateway", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "Anthropic stream ended before message_stop", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "stream ended before a terminal response event", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "ETIMEDOUT", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "stream terminated", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "billing_hard_limit_reached", expected: { kind: "quota_exhausted" } },

    // Round 3 & 4 additional cases
    { input: "Provider finish_reason: network_error", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "Provider stopped with: error (server error)", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "internal_error", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "Internal error", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "request timed out", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "HTTP/2 request did not get a response", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "WebSocket connect timeout", expected: { kind: "service_unavailable", input: "accepted" } },
    { input: "429 monthly usage limit reached", expected: { kind: "quota_exhausted" } },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(classifyPiFailure(input), expected, `Failed on input: ${input}`);
  }
});

test("classifyPiFailure non-string or empty input", () => {
  assert.equal(classifyPiFailure(""), null);
  assert.equal(classifyPiFailure("   "), null);
  assert.equal(classifyPiFailure(null), null);
  assert.equal(classifyPiFailure(undefined), null);
  assert.equal(classifyPiFailure(123), null);
});

test("isPiAuthError matcher cases", () => {
  // Positive cases matching exact Pi preflight messages
  assert.equal(
    isPiAuthError(
      "No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  providers.md"
    ),
    true
  );
  assert.equal(
    isPiAuthError(
      "No model selected.\n\nUse /login to log into a provider via OAuth or API key.\n\nThen use /model to select a model."
    ),
    true
  );
  assert.equal(
    isPiAuthError(
      'Authentication failed for "anthropic". Credentials may have expired or network is unavailable. Run \'/login anthropic\' to re-authenticate.'
    ),
    true
  );

  // Negative cases: generic auth / business auth / extension auth
  assert.equal(isPiAuthError("No API key found for Slack"), false);
  assert.equal(isPiAuthError("not logged in to Slack"), false);
  assert.equal(isPiAuthError("Authentication failed to load extension registry"), false);
  assert.equal(isPiAuthError("No API key in database"), false);
  assert.equal(isPiAuthError("Process terminated by user"), false);
  assert.equal(isPiAuthError("401 Unauthorized"), false);
  assert.equal(isPiAuthError(""), false);
  assert.equal(isPiAuthError(null), false);
  assert.equal(isPiAuthError(undefined), false);
});

test("getBase64DecodedSize 50 MiB limit cases", () => {
  const exact50MiB = Buffer.alloc(50 * 1024 * 1024).toString("base64");
  const over50MiB = Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64");
  assert.equal(getBase64DecodedSize(exact50MiB), 50 * 1024 * 1024);
  assert.equal(getBase64DecodedSize(over50MiB), 50 * 1024 * 1024 + 1);
  assert.equal(getBase64DecodedSize(exact50MiB) <= 50 * 1024 * 1024, true);
  assert.equal(getBase64DecodedSize(over50MiB) > 50 * 1024 * 1024, true);
});
