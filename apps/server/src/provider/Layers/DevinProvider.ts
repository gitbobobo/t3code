import * as NodeOS from "node:os";
import {
  type CustomModelSetting,
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  DEVIN_DEFAULT_MODEL_SLUG,
  devinSlashCommandsFromAvailableCommands,
  makeDevinAcpRuntime,
} from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Walking every advertised model through `session/set_config_option` takes
// roughly 20s on a healthy install; 60s leaves generous headroom.
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 60_000;
// `available_commands_update` is emitted before the `session/new` response, so
// it is normally already queued when we look; this only bounds the wait.
const AVAILABLE_COMMANDS_TIMEOUT_MS = 2_000;
const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG,
    name: "Devin default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ value: string; name: string }> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((option) => ({
          value: option.value.trim(),
          name: option.name.trim(),
        })),
  );
}

function findConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  id: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.id === id);
}

/**
 * Per-model capabilities from the `configOptions` a `session/set_config_option`
 * response advertises for that model: `thought_level` becomes the `reasoning`
 * select and `speed` the `fastMode` boolean.
 */
export function buildDevinCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const thoughtLevelOption = findConfigOption(configOptions, "thought_level");
  const reasoningOptions =
    thoughtLevelOption?.type === "select"
      ? flattenSelectOptions(thoughtLevelOption).flatMap((entry) =>
          entry.value
            ? [
                {
                  value: entry.value,
                  label: entry.name || entry.value,
                  ...(entry.value === thoughtLevelOption.currentValue ? { isDefault: true } : {}),
                },
              ]
            : [],
        )
      : [];

  const speedOption = findConfigOption(configOptions, "speed");
  const speedValues = new Set(flattenSelectOptions(speedOption).map((entry) => entry.value));
  const supportsFastMode = speedValues.has("fast") && speedValues.has("standard");

  return createModelCapabilities({
    optionDescriptors: [
      ...(reasoningOptions.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoning",
              label: "Reasoning",
              options: reasoningOptions,
            }),
          ]
        : []),
      ...(supportsFastMode
        ? [
            buildBooleanOptionDescriptor({
              id: "fastMode",
              label: "Fast Mode",
              ...(speedOption?.type === "select"
                ? { currentValue: speedOption.currentValue === "fast" }
                : {}),
            }),
          ]
        : []),
    ],
  });
}

export interface DevinDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * Opens one temporary session under the OS temp dir and walks every advertised
 * model through `session/set_config_option`, collecting each model's
 * thought_level/speed option set. The session is deleted afterwards. Devin only
 * accepts exact option values, so every model is visited explicitly.
 */
export const discoverDevinModelsViaAcp = (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  DevinDiscoveryResult,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      ...(environment ? { environment } : {}),
      childProcessSpawner,
      cwd: NodeOS.tmpdir(),
      mcpServers: [],
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });

    const started = yield* acp.start();
    return yield* Effect.gen(function* () {
      const configOptions = yield* acp.getConfigOptions;
      const modelOption = findConfigOption(configOptions, "model");
      const modelChoices = flattenSelectOptions(modelOption).filter((entry) => entry.value !== "");
      const initialModelValue =
        modelOption?.type === "select" ? modelOption.currentValue : undefined;

      const discovered: ServerProviderModel[] = [];
      const seen = new Set<string>();
      for (const choice of modelChoices) {
        if (seen.has(choice.value)) continue;
        seen.add(choice.value);
        const response = yield* acp.setConfigOption("model", choice.value);
        const modelConfigOptions =
          isRecord(response) && Array.isArray(response.configOptions)
            ? (response.configOptions as ReadonlyArray<EffectAcpSchema.SessionConfigOption>)
            : yield* acp.getConfigOptions;
        discovered.push({
          slug: choice.value,
          name: choice.name || choice.value,
          isCustom: false,
          ...(choice.value === initialModelValue ? { isDefault: true } : {}),
          capabilities: buildDevinCapabilitiesFromConfigOptions(modelConfigOptions),
        });
      }

      // The agent pushes `available_commands_update` right after `session/new`,
      // before its response lands, so this normally resolves off the queue.
      const availableCommands = yield* acp.getEvents().pipe(
        Stream.filterMap((event) =>
          event._tag === "AvailableCommandsUpdated"
            ? Result.succeed(event.availableCommands)
            : Result.failVoid,
        ),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(AVAILABLE_COMMANDS_TIMEOUT_MS)),
      );
      const slashCommands = Option.match(
        Option.flatMap(availableCommands, (commands) => commands),
        {
          onNone: () => [COMPACT_SLASH_COMMAND],
          onSome: (commands) => devinSlashCommandsFromAvailableCommands(commands),
        },
      );

      return { models: discovered, slashCommands } satisfies DevinDiscoveryResult;
    }).pipe(
      // Drop the probe session on every path — success, mid-walk failure, or
      // interruption — so it never lingers in `devin list`.
      Effect.ensuring(
        Effect.ignore(acp.request("session/delete", { sessionId: started.sessionId })),
      ),
    );
  }).pipe(Effect.scoped);

// Each driver instance owns its cache; version and account changes invalidate it.
export const makeDevinModelDiscovery = Effect.fn("makeDevinModelDiscovery")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const cache = yield* Cache.makeWith(
    (_key: string) => discoverDevinModelsViaAcp(devinSettings, environment),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.models.length > 0 ? Duration.minutes(30) : Duration.zero,
    },
  );
  return {
    discover: (probe: { readonly version: string | null; readonly auth: ServerProviderAuth }) =>
      Cache.get(cache, JSON.stringify([probe.version, probe.auth.status, probe.auth.email])),
    invalidate: Cache.invalidateAll(cache),
  };
});

/**
 * Parses `devin auth status`, which exits 0 whether or not the user is signed
 * in, so the output text is the only signal. Logged in it prints
 * `Logged in (via Devin).` and an `Email:` line; logged out it prints
 * `Not logged in.` and `Run \`devin auth login\` to authenticate.`
 */
export function parseDevinAuthStatus(output: string): {
  readonly authenticated: boolean | null;
  readonly email?: string;
} {
  const email = output.match(/^\s*Email:\s*(\S+)\s*$/m)?.[1]?.trim();
  if (/logged in/i.test(output) && !/not logged in/i.test(output)) {
    return { authenticated: true, ...(email ? { email } : {}) };
  }
  if (/not logged in/i.test(output)) {
    return { authenticated: false };
  }
  return { authenticated: null };
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  discoverModels?: (probe: {
    readonly version: string | null;
    readonly auth: ServerProviderAuth;
  }) => Effect.Effect<
    DevinDiscoveryResult,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`
      : "";
  const parsedAuth = parseDevinAuthStatus(authOutput);

  const auth: ServerProviderAuth = environment[DEVIN_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "Windsurf API key" }
    : parsedAuth.authenticated === true
      ? {
          status: "authenticated",
          type: "cached_token",
          label: "Devin account",
          ...(parsedAuth.email ? { email: parsedAuth.email } : {}),
        }
      : parsedAuth.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    // No ACP probe here: `devin acp` boots the user's configured MCP servers on
    // startup, so we only spawn it when sign-in is confirmed.
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  const discoveryExit = yield* Effect.exit(
    (discoverModels
      ? discoverModels({ version, auth })
      : discoverDevinModelsViaAcp(devinSettings, environment)
    ).pipe(Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS)),
  );

  let discovered: DevinDiscoveryResult | undefined;
  let discoveryWarning = false;
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Devin ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    discoveryWarning = true;
  } else if (Option.isNone(discoveryExit.value)) {
    discoveryWarning = true;
  } else if (discoveryExit.value.value.models.length === 0) {
    discoveryWarning = true;
  } else {
    discovered = discoveryExit.value.value;
  }

  const models = discovered
    ? devinModelsFromSettings(devinSettings.customModels, discovered.models)
    : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovered?.slashCommands ?? [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: discoveryWarning ? "warning" : "ready",
      auth,
      ...(discoveryWarning
        ? {
            message:
              "Devin CLI is installed but model discovery failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly settings: DevinSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
};
