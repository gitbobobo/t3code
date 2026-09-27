// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDevinTextGeneration } from "./DevinTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const DevinTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "devin",
    env: { T3_ACP_DEVIN: "1", ...env },
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
    }),
  });
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env);
    const config = decodeDevinSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeDevinTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(DevinTextGenerationTestLayer)("DevinTextGeneration", (it) => {
  it.effect("generates output without authenticate, in ask mode, deleting the session", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify devin acp text generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/devin-text-generation",
            stagedSummary: "M apps/server/src/textGeneration/DevinTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/DevinTextGeneration.ts b/apps/server/src/textGeneration/DevinTextGeneration.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("devin"),
              "swe-1-7-lightning-medium",
            ),
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify devin acp text generation");

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          const methods = requests.map((request) => request.method);
          expect(methods).not.toContain("authenticate");
          expect(methods).toContain("session/new");
          expect(methods).toContain("session/delete");
          // Ask mode is read-only for a text-generation helper.
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "mode" &&
                request.params?.value === "ask",
            ),
          ).toBe(true);
          // The requested model is advertised, so it is applied; the session's
          // current model already matches, so no write is needed.
        }),
    );
  });

  it.effect("fails closed when Ask mode cannot be set, and still deletes the session", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/devin-ask-fail",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("devin"),
                "swe-1-7-lightning-medium",
              ),
            }),
          );

          expect(error.detail).toBe("Devin could not enter read-only Ask mode.");

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as { method?: string });
          const methods = requests.map((request) => request.method);
          // Never prompt a session that failed to go read-only; the throwaway
          // session must still be deleted on the failure path.
          expect(methods).not.toContain("session/prompt");
          expect(methods).toContain("session/delete");
        }),
    );
  });

  it.effect("keeps the session model when the selection is not advertised", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "Generated title",
          needsRefinement: false,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "rename the thing",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("devin"),
              "not-a-real-model",
            ),
          });

          expect(generated.title).toBe("Generated title");

          const requests = NodeFS.readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );
          // An unadvertised model must not be written: Devin would reject the
          // set_config_option call with invalid params.
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model",
            ),
          ).toBe(false);
        }),
    );
  });
});
