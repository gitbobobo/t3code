// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockRuntimeOptions = {
  spawn: {
    command: "node",
    args: [mockAgentPath],
    env: { T3_ACP_DEVIN: "1" },
  },
  cwd: process.cwd(),
  clientInfo: { name: "t3-test", version: "0.0.0" },
} satisfies Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "authMethodId">;

describe("AcpSessionRuntime", () => {
  it.effect("skips authenticate entirely when no authMethodId is configured", () =>
    Effect.gen(function* () {
      const methods: Array<string> = [];
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        requestLogger: (event) =>
          Effect.sync(() => {
            methods.push(event.method);
          }),
      });
      // The mock's Devin profile fails any authenticate request, so start()
      // succeeding at all proves no authenticate was sent.
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");
      expect(methods).toContain("initialize");
      expect(methods).toContain("session/new");
      expect(methods).not.toContain("authenticate");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sends authenticate when authMethodId is configured", () =>
    Effect.gen(function* () {
      const methods: Array<string> = [];
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        authMethodId: "test",
        spawn: { ...mockRuntimeOptions.spawn, env: {} },
        requestLogger: (event) =>
          Effect.sync(() => {
            methods.push(event.method);
          }),
      });
      yield* runtime.start();
      expect(methods).toEqual(
        expect.arrayContaining(["initialize", "authenticate", "session/new"]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
