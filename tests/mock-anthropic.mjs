#!/usr/bin/env node

// Minimal stand-in for GET /api/oauth/usage so the collector can be tested
// without a real subscription token.

import { createServer } from "node:http";

export function startMockAnthropic({ expectedToken = "test-oauth-token", status = 200 } = {}) {
  const server = createServer((request, response) => {
    if (request.url.startsWith("/v1/oauth/token")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.grant_type !== "refresh_token" || parsed.refresh_token !== "test-refresh-token") {
          response.writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            access_token: expectedToken,
            refresh_token: "test-refresh-token-2",
            expires_in: 3600,
          }),
        );
      });
      return;
    }
    if (!request.url.startsWith("/api/oauth/usage")) {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: { type: "authentication_error" } }),
      );
      return;
    }
    if (status !== 200) {
      response.writeHead(status, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        // five_hour deliberately carries fields the collector does not map, plus
        // one the sanitizer forbids by name. Both are what the field probe has to
        // handle: report the unread numbers, and never let an unexpected key name
        // reach the state file and fail the credential check.
        five_hour: {
          utilization: 12.5,
          resets_at: "2026-08-08T04:00:00Z",
          used_tokens: 1234567,
          limit_tokens: 9876543,
          window_label: "session",
          access_token: "must-never-be-copied",
        },
        seven_day: { utilization: 81, resets_at: "2026-08-12T00:00:00Z" },
        seven_day_sonnet: { utilization: 40, resets_at: "2026-08-12T00:00:00Z" },
        extra_usage: { utilization: 3, spent_cents: 120, limit_cents: 4000 },
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
