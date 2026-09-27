// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDevinCapabilitiesFromConfigOptions,
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinAuthStatus,
} from "./DevinProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_OUTPUT = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File:              /home/user/.local/share/devin/credentials.toml",
  "",
  "User:",
  "  Email:             user@example.com",
  "",
].join("\n");

const LOGGED_OUT_OUTPUT = [
  "Not logged in.",
  "",
  "Run `devin auth login` to authenticate.",
  "",
].join("\n");

describe("parseDevinAuthStatus", () => {
  it("reads a logged-in CLI, including the account email", () => {
    expect(parseDevinAuthStatus(LOGGED_IN_OUTPUT)).toEqual({
      authenticated: true,
      email: "user@example.com",
    });
  });

  it("detects a logged-out CLI even though it exits 0", () => {
    expect(parseDevinAuthStatus(LOGGED_OUT_OUTPUT)).toEqual({ authenticated: false });
  });

  it("returns unknown for unrecognized output", () => {
    expect(parseDevinAuthStatus("devin 3000.11.3\n")).toEqual({ authenticated: null });
  });
});

describe("buildDevinCapabilitiesFromConfigOptions", () => {
  const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "accept-edits",
      options: [{ value: "accept-edits", name: "Code" }],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    {
      id: "speed",
      name: "Speed",
      category: "model_config",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "standard", name: "Standard" },
        { value: "fast", name: "Fast" },
      ],
    },
  ];

  it("builds reasoning and fastMode descriptors, marking the current value", () => {
    const capabilities = buildDevinCapabilitiesFromConfigOptions(configOptions);
    const reasoning = capabilities.optionDescriptors?.find((option) => option.id === "reasoning");
    const fastMode = capabilities.optionDescriptors?.find((option) => option.id === "fastMode");
    expect(reasoning?.type).toBe("select");
    if (reasoning?.type === "select") {
      expect(reasoning.options.map((option) => option.id)).toEqual(["low", "high"]);
      expect(reasoning.currentValue).toBe("high");
    }
    expect(fastMode).toMatchObject({ type: "boolean", currentValue: true });
  });

  it("returns empty capabilities when no per-model options exist", () => {
    expect(buildDevinCapabilitiesFromConfigOptions([]).optionDescriptors).toEqual([]);
    expect(buildDevinCapabilitiesFromConfigOptions([configOptions[0]!]).optionDescriptors).toEqual(
      [],
    );
  });
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  // A stand-in for the Devin CLI: `version` and `auth status` print canned text,
  // and `acp` execs the mock ACP agent in Devin profile.
  const writeFakeDevinCli = (input: {
    readonly authOutput: string;
    readonly acp: boolean;
    readonly env?: Record<string, string>;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "devin",
        env: { T3_ACP_DEVIN: "1", ...input.env },
        source: [
          'if (process.argv[2] === "version") {',
          '  process.stdout.write("devin 3000.11.3 (9c803229faa4)\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "auth") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.authOutput)});`,
          "  process.exit(0);",
          "}",
          'if (process.argv[2] !== "acp") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports an error and skips the ACP probe when logged out", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_OUT_OUTPUT,
            // acp exits 3 if spawned; the probe must never reach it.
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["devin-default"]);
    }),
  );

  it.effect("reports ready with discovered models when signed in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("3000.11.3");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Devin account",
        email: "user@example.com",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "adaptive",
        "swe-1-7-lightning-medium",
      ]);
      const lightning = snapshot.models.find((model) => model.slug === "swe-1-7-lightning-medium");
      expect(lightning?.isDefault).toBe(true);
      expect(lightning?.capabilities?.optionDescriptors?.map((option) => option.id) ?? []).toEqual([
        "reasoning",
        "fastMode",
      ]);
      const adaptive = snapshot.models.find((model) => model.slug === "adaptive");
      expect(adaptive?.capabilities?.optionDescriptors ?? []).toEqual([]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact", "help"]);
    }),
  );

  it.effect("reports a warning with fallback models when discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_OUTPUT,
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["devin-default"]);
      expect(snapshot.message).toContain("model discovery failed");
    }),
  );

  it.effect("still deletes the probe session when the model walk fails", () =>
    Effect.gen(function* () {
      const { snapshot, methods } = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const logDir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3code-devin-probe-log-",
          });
          const requestLogPath = NodePath.join(logDir, "requests.ndjson");
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_OUTPUT,
            acp: true,
            env: {
              T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          });
          const snapshot = yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
          const raw = yield* fs.readFileString(requestLogPath);
          const methods = raw
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => (JSON.parse(line) as { method?: string }).method);
          return { snapshot, methods };
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["devin-default"]);
      expect(methods).not.toContain("authenticate");
      expect(methods).toContain("session/new");
      expect(methods).toContain("session/delete");
    }),
  );

  it.effect("treats WINDSURF_API_KEY as authenticated regardless of CLI login state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_OUT_OUTPUT,
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "ws-test-key" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "Windsurf API key",
      });
      // The API key authenticates, so the ACP probe runs and fails on the
      // non-ACP binary, surfacing the discovery warning rather than a login error.
      expect(snapshot.status).toBe("warning");
    }),
  );

  it.effect("returns a disabled snapshot without probing when disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: false,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["devin-default"]);
    }),
  );

  it.effect("builds the initial snapshot without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toBe("Checking Devin CLI availability...");
    }),
  );
});
