import {
  type DevinSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

// No `authMethodId`: Devin's only ACP auth method (`devin-browser`) always opens a
// browser PKCE login, even with stored credentials, so T3 must never send
// `authenticate`. Sign-in is probed with `devin auth status` instead.
export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in Devin slug. It is a product placeholder, not a model id the ACP
 * accepts, so selecting it means "use whatever model the Devin session runs on".
 */
export const DEVIN_DEFAULT_MODEL_SLUG = "devin-default";

const DEVIN_MODE_CONFIG_ID = "mode";
const DEVIN_MODEL_CONFIG_ID = "model";
const DEVIN_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const DEVIN_SPEED_CONFIG_ID = "speed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenSelectOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<string> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value.trim()] : entry.options.map((option) => option.value.trim()),
  );
}

function findConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  id: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.id === id);
}

/**
 * Maps T3's runtime/interaction mode onto Devin's `mode` config option. Devin's
 * strictest always-ask mode is not exposed over ACP, so approval-required and
 * auto-accept-edits both land on "accept-edits"; "smart" is still rolling out,
 * so a missing target falls back to "accept-edits" rather than failing.
 */
export function resolveDevinModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
}): string | undefined {
  const modeOption = findConfigOption(input.configOptions, DEVIN_MODE_CONFIG_ID);
  if (!modeOption || modeOption.type !== "select") {
    return undefined;
  }
  const values = flattenSelectOptionValues(modeOption);
  const target =
    input.interactionMode === "plan"
      ? "plan"
      : input.runtimeMode === "full-access"
        ? "bypass"
        : input.runtimeMode === "auto"
          ? "smart"
          : "accept-edits";
  const resolved = values.includes(target)
    ? target
    : values.includes("accept-edits")
      ? "accept-edits"
      : undefined;
  if (resolved === undefined || resolved === modeOption.currentValue) {
    return undefined;
  }
  return resolved;
}

/**
 * Turns model-selection options into `session/set_config_option` writes against
 * Devin's per-model `thought_level` and `speed` options. Anything the live
 * option set does not advertise is skipped silently.
 */
export function resolveDevinConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0 || !selections || selections.length === 0) {
    return [];
  }

  const updates: Array<{ configId: string; value: string | boolean }> = [];

  const thoughtLevelOption = findConfigOption(configOptions, DEVIN_THOUGHT_LEVEL_CONFIG_ID);
  const requestedReasoning = getProviderOptionStringSelectionValue(selections, "reasoning")
    ?.trim()
    .toLowerCase();
  if (thoughtLevelOption && requestedReasoning) {
    const value = flattenSelectOptionValues(thoughtLevelOption).find(
      (optionValue) => optionValue.toLowerCase() === requestedReasoning,
    );
    if (value !== undefined) {
      updates.push({ configId: thoughtLevelOption.id, value });
    }
  }

  const speedOption = findConfigOption(configOptions, DEVIN_SPEED_CONFIG_ID);
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (speedOption && typeof requestedFastMode === "boolean") {
    const value = requestedFastMode ? "fast" : "standard";
    if (flattenSelectOptionValues(speedOption).includes(value)) {
      updates.push({ configId: speedOption.id, value });
    }
  }

  return updates;
}

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly configId?: string;
}

/**
 * Applies a T3 model selection to a Devin session. "devin-default" (or no model)
 * leaves the session's model untouched; any other slug is written to the `model`
 * config option first so `thought_level`/`speed` updates are resolved against the
 * refreshed option set for that model.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    let configOptions = yield* input.runtime.getConfigOptions;

    const requestedModel = input.model?.trim();
    if (requestedModel && requestedModel !== DEVIN_DEFAULT_MODEL_SLUG) {
      const modelOption = findConfigOption(configOptions, DEVIN_MODEL_CONFIG_ID);
      if (modelOption?.type === "select" && modelOption.currentValue !== requestedModel) {
        const response = yield* input.runtime
          .setConfigOption(DEVIN_MODEL_CONFIG_ID, requestedModel)
          .pipe(
            Effect.mapError((cause) => input.mapError({ cause, configId: DEVIN_MODEL_CONFIG_ID })),
          );
        if (isRecord(response) && Array.isArray(response.configOptions)) {
          configOptions =
            response.configOptions as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
        } else {
          configOptions = yield* input.runtime.getConfigOptions;
        }
      }
    }

    for (const update of resolveDevinConfigUpdates(configOptions, input.selections)) {
      yield* input.runtime
        .setConfigOption(update.configId, update.value)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: update.configId })));
    }
  });
}

/**
 * Picks the Devin permission option for a T3 approval decision. Only
 * session-scoped choices are returned: `allow_always`, `allow_always_global`,
 * and `switch_bypass` persist outside T3 or change the session mode, so they are
 * never selected automatically — not even in full-access, where bypass mode
 * already covers routine approvals.
 */
export function selectDevinPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: "accept" | "acceptAlways" | "acceptForSession" | "decline",
): string | undefined {
  const byOptionId = (optionId: string) =>
    request.options.find((option) => option.optionId === optionId)?.optionId;
  const byKind = (kind: string) =>
    request.options.find((option) => option.kind === kind && option.optionId.trim() !== "")
      ?.optionId;

  switch (decision) {
    case "accept":
      return byOptionId("allow_once") ?? byKind("allow_once");
    case "acceptAlways":
    case "acceptForSession":
      return byOptionId("allow_session") ?? byKind("allow_once");
    case "decline":
      return byOptionId("reject_once") ?? byKind("reject_once");
  }
}

const DEVIN_PLAN_TOOL_META_KEY = "cognition.ai/inferenceToolName";

/**
 * Reads plan markdown out of a Devin `write_plan` tool call payload (the
 * `session/update` notification body). Devin writes the plan to a file and
 * reports it as a diff edit; the file's YAML frontmatter is Devin bookkeeping,
 * not plan content, so it is stripped.
 */
export function extractDevinPlanMarkdown(rawToolCall: unknown): string | undefined {
  if (!isRecord(rawToolCall)) {
    return undefined;
  }
  const update = rawToolCall.update;
  if (!isRecord(update)) {
    return undefined;
  }
  const meta = update._meta;
  if (!isRecord(meta) || meta[DEVIN_PLAN_TOOL_META_KEY] !== "write_plan") {
    return undefined;
  }
  const content = update.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== "diff" || typeof entry.newText !== "string") {
      continue;
    }
    const markdown = entry.newText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return markdown.length > 0 ? markdown : undefined;
  }
  return undefined;
}

// Commands that change permissions, mode, model, auth, or workspace from the
// agent side. They must go through T3 so the client and provider stay in sync.
const DEVIN_BLOCKED_SLASH_COMMANDS = new Set([
  "login",
  "logout",
  "workspace",
  "add-dir",
  "remove-dir",
  "code",
  "smart",
  "bypass",
  "plan",
  "ask",
  "fast",
  "normal",
  "accept-edits",
  "yolo",
  "dangerous",
  "mode",
  "model",
]);

export function devinSlashCommandsFromAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>([
    [COMPACT_SLASH_COMMAND.name, COMPACT_SLASH_COMMAND],
  ]);
  for (const command of commands) {
    const name = command.name.trim();
    if (!name || DEVIN_BLOCKED_SLASH_COMMANDS.has(name.toLowerCase())) {
      continue;
    }
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    byName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return [...byName.values()];
}
