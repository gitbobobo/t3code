// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

// Test-local service tag so the rest of the file can keep using `yield* DevinAdapter`.
class DevinAdapter extends Context.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Layers/DevinAdapter.test/DevinAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-devin",
    env: { T3_ACP_DEVIN: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const makeResolveDevinSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.devin),
      Effect.orDie,
    ),
  );
});

const devinAdapterTestLayer = it.layer(
  Layer.effect(
    DevinAdapter,
    Effect.gen(function* () {
      const devinConfig = decodeDevinSettings({});
      const resolveSettings = yield* makeResolveDevinSettings;
      return yield* makeDevinAdapter(devinConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-devin-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

devinAdapterTestLayer("DevinAdapterLive", (it) => {
  it.effect("starts a session without authenticate and applies mode/model config options", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-mock-thread");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: {
          ...createModelSelection(ProviderInstanceId.make("devin"), "adaptive"),
          options: [{ id: "reasoning", value: "high" }],
        },
      });

      assert.equal(session.provider, "devin");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello mock", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((entry) => entry.method);
      assert.notInclude(methods, "authenticate");
      assert.include(methods, "session/new");

      const configWrites = requests.filter((entry) => entry.method === "session/set_config_option");
      assert.isTrue(
        configWrites.some(
          (entry) =>
            (entry.params as { configId?: string }).configId === "model" &&
            (entry.params as { value?: string }).value === "adaptive",
        ),
      );
      assert.isTrue(
        configWrites.some(
          (entry) =>
            (entry.params as { configId?: string }).configId === "mode" &&
            (entry.params as { value?: string }).value === "smart",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps acceptForSession to Devin's allow_session permission option", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-permission-thread");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-perm-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const turnCompleted = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "acceptForSession",
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.orDie);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run a tool call", attachments: [] });
      yield* Deferred.await(turnCompleted);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const permissionResponse = requests.find(
        (entry) =>
          !("method" in entry) &&
          typeof entry.result === "object" &&
          entry.result !== null &&
          "outcome" in entry.result &&
          typeof entry.result.outcome === "object" &&
          entry.result.outcome !== null &&
          "outcome" in entry.result.outcome &&
          entry.result.outcome.outcome === "selected" &&
          "optionId" in entry.result.outcome &&
          entry.result.outcome.optionId === "allow_session",
      );
      assert.isDefined(permissionResponse);

      assert.includeMembers(
        runtimeEvents
          .filter((event) => String(event.threadId) === String(threadId))
          .map((event) => event.type),
        ["request.opened", "request.resolved", "turn.completed"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits turn.proposed.completed with stripped plan markdown for write_plan", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-plan-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_DEVIN_PLAN: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const turnCompleted = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) === String(threadId)) {
            runtimeEvents.push(event);
            if (event.type === "turn.completed") {
              yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "plan something", attachments: [] });
      yield* Deferred.await(turnCompleted);

      const proposed = runtimeEvents.filter((event) => event.type === "turn.proposed.completed");
      assert.lengthOf(proposed, 1);
      const proposal = proposed[0];
      if (proposal?.type === "turn.proposed.completed") {
        assert.equal(
          (proposal.payload as { planMarkdown?: string }).planMarkdown,
          "# Mock Devin plan\n\n- Step one",
        );
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a persisted session through session/load", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-resume-thread");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-resume-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "previous-session-1" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "previous-session-1",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((entry) => entry.method);
      assert.notInclude(methods, "authenticate");
      assert.include(methods, "session/load");
      assert.notInclude(methods, "session/new");
      const loadRequest = requests.find((entry) => entry.method === "session/load");
      assert.equal(
        (loadRequest?.params as { sessionId?: string } | undefined)?.sessionId,
        "previous-session-1",
      );

      yield* adapter.stopSession(threadId);
    }),
  );
});
