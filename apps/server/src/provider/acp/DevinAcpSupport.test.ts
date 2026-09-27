import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderOptionSelection } from "@t3tools/contracts";
import type { RequestPermissionRequest } from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  devinSlashCommandsFromAvailableCommands,
  extractDevinPlanMarkdown,
  resolveDevinConfigUpdates,
  resolveDevinModeId,
  selectDevinPermissionOptionId,
} from "./DevinAcpSupport.ts";

const DEVIN_MODES = [
  { value: "accept-edits", name: "Code" },
  { value: "smart", name: "Smart" },
  { value: "ask", name: "Ask" },
  { value: "plan", name: "Plan" },
  { value: "bypass", name: "Bypass Permissions" },
];

function devinConfigOptions(input?: {
  readonly currentMode?: string;
  readonly currentModel?: string;
  readonly modes?: ReadonlyArray<{ value: string; name: string }>;
  readonly thoughtLevels?: ReadonlyArray<{ value: string; name: string }>;
  readonly speed?: boolean;
}): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: input?.currentMode ?? "accept-edits",
      options: input?.modes ?? DEVIN_MODES,
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: input?.currentModel ?? "swe-1-7-lightning-medium",
      options: [
        { value: "adaptive", name: "Adaptive" },
        { value: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning" },
      ],
    },
    ...(input?.thoughtLevels
      ? [
          {
            id: "thought_level",
            name: "Thought Level",
            category: "thought_level" as const,
            type: "select" as const,
            currentValue: "medium",
            options: [...input.thoughtLevels],
          },
        ]
      : []),
    ...(input?.speed
      ? [
          {
            id: "speed",
            name: "Speed",
            category: "model_config" as const,
            type: "select" as const,
            currentValue: "standard",
            options: [
              { value: "standard", name: "Standard" },
              { value: "fast", name: "Fast" },
            ],
          },
        ]
      : []),
  ];
}

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path and passes the environment through", () => {
    const env = { WINDSURF_API_KEY: "key" } as NodeJS.ProcessEnv;
    expect(buildDevinAcpSpawnInput({ binaryPath: "/opt/devin" }, "/tmp/project", env)).toEqual({
      command: "/opt/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env,
    });
  });
});

describe("resolveDevinModeId", () => {
  const options = devinConfigOptions();

  it("maps interaction mode plan to plan", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: "plan",
        configOptions: options,
      }),
    ).toBe("plan");
  });

  it.each(["approval-required", "auto-accept-edits"] as const)(
    "maps %s to accept-edits",
    (runtimeMode) => {
      expect(
        resolveDevinModeId({
          runtimeMode,
          interactionMode: "default",
          configOptions: devinConfigOptions({ currentMode: "plan" }),
        }),
      ).toBe("accept-edits");
    },
  );

  it("maps auto to smart", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "auto",
        interactionMode: "default",
        configOptions: options,
      }),
    ).toBe("smart");
  });

  it("falls back to accept-edits when smart is not advertised", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "auto",
        interactionMode: "default",
        configOptions: devinConfigOptions({
          currentMode: "plan",
          modes: DEVIN_MODES.filter((mode) => mode.value !== "smart"),
        }),
      }),
    ).toBe("accept-edits");
  });

  it("maps full-access to bypass", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: "default",
        configOptions: options,
      }),
    ).toBe("bypass");
  });

  it("returns undefined when the target is already active or unavailable", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "approval-required",
        interactionMode: "default",
        configOptions: options,
      }),
    ).toBeUndefined();
    expect(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: "default",
        configOptions: devinConfigOptions({
          modes: [{ value: "ask", name: "Ask" }],
        }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no mode option exists", () => {
    expect(
      resolveDevinModeId({
        runtimeMode: "auto",
        interactionMode: "default",
        configOptions: [],
      }),
    ).toBeUndefined();
  });
});

describe("resolveDevinConfigUpdates", () => {
  const withThoughtAndSpeed = devinConfigOptions({
    thoughtLevels: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
    speed: true,
  });
  const bare = devinConfigOptions();

  it("maps reasoning to thought_level and fastMode to speed", () => {
    const selections: ReadonlyArray<ProviderOptionSelection> = [
      { id: "reasoning", value: "high" },
      { id: "fastMode", value: true },
    ];
    expect(resolveDevinConfigUpdates(withThoughtAndSpeed, selections)).toEqual([
      { configId: "thought_level", value: "high" },
      { configId: "speed", value: "fast" },
    ]);
  });

  it("skips reasoning values the model does not advertise", () => {
    expect(
      resolveDevinConfigUpdates(withThoughtAndSpeed, [{ id: "reasoning", value: "xhigh" }]),
    ).toEqual([]);
    expect(resolveDevinConfigUpdates(bare, [{ id: "reasoning", value: "high" }])).toEqual([]);
  });

  it("maps fastMode false to standard and skips when speed is absent", () => {
    expect(
      resolveDevinConfigUpdates(withThoughtAndSpeed, [{ id: "fastMode", value: false }]),
    ).toEqual([{ configId: "speed", value: "standard" }]);
    expect(resolveDevinConfigUpdates(bare, [{ id: "fastMode", value: true }])).toEqual([]);
  });
});

describe("selectDevinPermissionOptionId", () => {
  const request = {
    sessionId: "s1",
    toolCall: { toolCallId: "t1" },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_session", name: "Allow this session", kind: "allow_always" },
      { optionId: "allow_always", name: "Always allow in project", kind: "allow_always" },
      { optionId: "allow_always_global", name: "Always allow everywhere", kind: "allow_always" },
      { optionId: "switch_bypass", name: "Switch to bypass", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  } as unknown as RequestPermissionRequest;

  it("maps accept to allow_once", () => {
    expect(selectDevinPermissionOptionId(request, "accept")).toBe("allow_once");
  });

  it("maps acceptForSession to allow_session, never persistent options", () => {
    expect(selectDevinPermissionOptionId(request, "acceptForSession")).toBe("allow_session");
  });

  it("falls back to allow_once when allow_session is absent", () => {
    const withoutSession = {
      ...request,
      options: request.options.filter(
        (option: { optionId: string }) => option.optionId !== "allow_session",
      ),
    } as typeof request;
    expect(selectDevinPermissionOptionId(withoutSession, "acceptForSession")).toBe("allow_once");
  });

  it("maps decline to reject_once", () => {
    expect(selectDevinPermissionOptionId(request, "decline")).toBe("reject_once");
  });

  it("returns undefined when no usable option exists", () => {
    const empty = { ...request, options: [] } as unknown as typeof request;
    expect(selectDevinPermissionOptionId(empty, "accept")).toBeUndefined();
    expect(selectDevinPermissionOptionId(empty, "decline")).toBeUndefined();
  });
});

describe("extractDevinPlanMarkdown", () => {
  const planDiff = "---\nagent: devin-local\nsession: s1\n---\n# Plan title\n\n- Step one\n";

  it("strips YAML frontmatter from a write_plan diff", () => {
    const payload = {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "functions.write_plan:1",
        kind: "edit",
        content: [{ type: "diff", path: "/plans/plan-1.md", newText: planDiff }],
        _meta: { "cognition.ai/inferenceToolName": "write_plan" },
      },
    };
    expect(extractDevinPlanMarkdown(payload)).toBe("# Plan title\n\n- Step one");
  });

  it("ignores tool calls that are not write_plan", () => {
    const payload = {
      update: {
        sessionUpdate: "tool_call",
        content: [{ type: "diff", newText: planDiff }],
        _meta: { "cognition.ai/inferenceToolName": "edit" },
      },
    };
    expect(extractDevinPlanMarkdown(payload)).toBeUndefined();
    expect(
      extractDevinPlanMarkdown({
        update: { sessionUpdate: "tool_call", content: [] },
      }),
    ).toBeUndefined();
    expect(extractDevinPlanMarkdown("nope")).toBeUndefined();
  });
});

describe("devinSlashCommandsFromAvailableCommands", () => {
  it("keeps compact and safe commands while dropping permission/mode/model/auth commands", () => {
    const commands = devinSlashCommandsFromAvailableCommands([
      { name: "compact", description: "Native compact" },
      { name: "help", description: "Show help" },
      { name: "model", description: "Switch model" },
      { name: "plan", description: "Plan mode" },
      { name: "login", description: "Sign in" },
      { name: "add-dir", description: "Add a directory" },
      { name: "bypass", description: "Skip permissions" },
      { name: "status", description: "Show status", input: { hint: "on|off" } },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["compact", "help", "status"]);
    expect(commands[2]?.input).toEqual({ hint: "on|off" });
  });
});

describe("applyDevinAcpModelSelection", () => {
  function makeRuntime(initial: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
    return Effect.gen(function* () {
      const callsRef = yield* Ref.make<
        ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }>
      >([]);
      let configOptions = initial;
      const runtime = {
        getConfigOptions: Effect.sync(() => configOptions),
        setConfigOption: (configId: string, value: string | boolean) =>
          Ref.update(callsRef, (calls) => [...calls, { configId, value }]).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                configOptions = configOptions.map((option) =>
                  option.id === configId && option.type === "select"
                    ? { ...option, currentValue: String(value) }
                    : option,
                );
              }),
            ),
            Effect.map(() => ({ configOptions })),
          ),
      };
      return { runtime, callsRef, getCalls: () => Ref.get(callsRef) };
    });
  }

  it("does not touch the model for the devin-default slug", () =>
    Effect.gen(function* () {
      const { runtime, getCalls } = yield* makeRuntime(
        devinConfigOptions({ thoughtLevels: [{ value: "high", name: "High" }] }),
      );
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "devin-default",
        selections: [{ id: "reasoning", value: "high" }],
        mapError: (context) => context,
      });
      const calls = yield* getCalls();
      expect(calls).toEqual([{ configId: "thought_level", value: "high" }]);
    }).pipe(Effect.runPromise));

  it("writes the model first, then applies config updates", () =>
    Effect.gen(function* () {
      const { runtime, getCalls } = yield* makeRuntime(
        devinConfigOptions({ thoughtLevels: [{ value: "high", name: "High" }] }),
      );
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "adaptive",
        selections: [{ id: "reasoning", value: "high" }],
        mapError: (context) => context,
      });
      const calls = yield* getCalls();
      expect(calls).toEqual([
        { configId: "model", value: "adaptive" },
        { configId: "thought_level", value: "high" },
      ]);
    }).pipe(Effect.runPromise));

  it("skips the model write when the requested model is already active", () =>
    Effect.gen(function* () {
      const { runtime, getCalls } = yield* makeRuntime(
        devinConfigOptions({ currentModel: "adaptive" }),
      );
      yield* applyDevinAcpModelSelection({
        runtime,
        model: "adaptive",
        selections: [],
        mapError: (context) => context,
      });
      expect(yield* getCalls()).toEqual([]);
    }).pipe(Effect.runPromise));
});
