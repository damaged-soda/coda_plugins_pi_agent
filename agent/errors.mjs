// Failure classification for session/prompt errors per Coda agent protocol.
// Mirrors Pi's retryable and non-retryable provider error patterns.

const REQUEST_VALIDATION_PATTERN = /(?:invalid_request_error|invalid\s*request|bad\s*request|\b400\b|\b422\b|validation|must\s*be|invalid\s*.{0,30}?(?:parameter|argument|value|address))/i;
const CONFIG_OR_CODE_EXCLUSION = /(?:\bconfig(?:uration)?\b|\binvalid\b.{0,40}\bcode\b)/i;
const AUTH_PATTERN = /(?:\b401\b|unauthorized|invalid\s*api\s*key|authentication)/i;
const CONTEXT_OVERFLOW_PATTERN = /(?:context\s*length|maximum\s*context|too\s*long)/i;
const RATE_LIMIT_PATTERN = /(?:rate.?limit|too many requests|\b429\b(?!.*quota)|ResourceExhausted)/i;

const QUOTA_PATTERN = new RegExp([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "insufficient (?:available )?balance",
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "subscription_sharing_usage_limit_exceeded",
  "credit balance is too low",
  "exceeded your current quota",
  "billing_hard_limit_reached",
  "usage limit (?:reached|exceeded)",
  "reached your .{0,40}usage limit",
].join("|"), "i");

const RETRYABLE_SERVICE_PATTERNS = [
  "^\\s*(?:error:?\\s*)?5(?:00|02|03|04|20|24|29)\\b",
  "\\b(?:http|status|status code|code)[\\s:=]*5(?:00|02|03|04|20|24|29)\\b",
  "\\b5(?:00|02|03|04|20|24|29)\\b\\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)",
  "ETIMEDOUT",
  "\\btimeout\\b",
  "\\btimed\\s+out\\b",
  "\\brequest timed? ?out\\b",
  "\\b(?:request|stream|connection|socket|upstream|provider|gateway).{0,30}?\\btimed?\\s*out\\b",
  "\\btimed?\\s*out\\b.{0,30}?\\b(?:request|stream|connection|socket|upstream|provider|gateway)\\b",
  "stream terminated",
  "^\\s*terminated\\s*$",
  "socket hang up",
  "ECONNRESET",
  "fetch failed",
  "other side closed",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "ended without (?:a )?(?:message_stop|terminal)",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "internal server error",
  "\\bserver error\\b(?!\\s+code)",
  "\\bserver_error\\b",
  "\\binternal error\\b",
  "\\binternal_error\\b",
  "model is at capacity",
  "server_busy",
  "servers are currently busy",
  "currently experiencing high demand",
  "connection (?:refused|reset|lost|error)",
  "upstream connect",
  "reset before headers",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "http/?2 request did not get a response",
  "pending stream has been canceled",
  "websocket.{0,20}(?:closed|error|timeout)",
  "socket connection was closed",
  "(?:websocket|socket|connect(?:ion)?)\\s+time(?:d\\s*)?out",
  "network.?error",
  "provider.?returned.?error",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
  "exceeded request buffer limit while retrying upstream",
];

const SERVICE_PATTERN = new RegExp(RETRYABLE_SERVICE_PATTERNS.join("|"), "i");

export function classifyPiFailure(errorMessage) {
  if (typeof errorMessage !== "string" || !errorMessage.trim()) return null;
  if (QUOTA_PATTERN.test(errorMessage)) return { kind: "quota_exhausted" };
  if (CONFIG_OR_CODE_EXCLUSION.test(errorMessage)) return null;
  if (REQUEST_VALIDATION_PATTERN.test(errorMessage)) return null;
  if (AUTH_PATTERN.test(errorMessage)) return null;
  if (CONTEXT_OVERFLOW_PATTERN.test(errorMessage)) return null;
  if (RATE_LIMIT_PATTERN.test(errorMessage)) return null;
  if (SERVICE_PATTERN.test(errorMessage)) return { kind: "service_unavailable", input: "accepted" };
  return null;
}

export function isPiAuthError(message) {
  if (typeof message !== "string") return false;
  const isNoKeyOrModel =
    (message.startsWith("No API key found for ") || message.startsWith("No model selected.")) &&
    message.includes("Use /login to log into a provider");
  const isAuthFailed =
    message.startsWith('Authentication failed for "') &&
    message.includes("Run '/login ") &&
    message.includes("to re-authenticate");
  return isNoKeyOrModel || isAuthFailed;
}

export function getBase64DecodedSize(base64Str) {
  if (typeof base64Str !== "string") return 0;
  const clean = base64Str.replace(/\s+/g, "");
  const len = clean.length;
  if (len === 0) return 0;
  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;
  return Math.floor(len / 4) * 3 - padding;
}
