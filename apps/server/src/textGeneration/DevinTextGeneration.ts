import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type DevinSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  DEVIN_DEFAULT_MODEL_SLUG,
  makeDevinAcpRuntime,
  selectDevinPermissionOptionId,
} from "../provider/acp/DevinAcpSupport.ts";

const DEVIN_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a Devin text-generation closure bound to a specific `DevinSettings`
 * payload. See `makeCursorTextGeneration` for the overall per-instance
 * rationale. Devin never receives `authenticate` (its only method opens a
 * browser login), runs in the read-only `ask` mode, and every permission
 * request is declined; the throwaway session is deleted afterwards.
 */
export const makeDevinTextGeneration = Effect.fn("makeDevinTextGeneration")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const runDevinJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeDevinAcpRuntime({
        devinSettings,
        environment: resolvedEnvironment,
        childProcessSpawner: commandSpawner,
        cwd,
        mcpServers: [],
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });
      // Read-only helper: decline anything the agent wants approval for.
      yield* runtime.handleRequestPermission((params) => {
        const optionId = selectDevinPermissionOptionId(params, "decline");
        return Effect.succeed(
          optionId === undefined
            ? ({ outcome: { outcome: "cancelled" } } as const)
            : ({ outcome: { outcome: "selected", optionId } } as const),
        );
      });

      const started = yield* runtime.start().pipe(
        Effect.timeout(DEVIN_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Devin ACP request failed.",
              cause,
            }),
        ),
      );
      const promptResult = yield* Effect.gen(function* () {
        // Fail closed: without Ask mode Devin stays in accept-edits, where
        // workspace edits auto-approve without a permission request.
        yield* runtime.setConfigOption("mode", "ask").pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Devin could not enter read-only Ask mode.",
                cause,
              }),
          ),
        );

        // Only apply a model that the session actually advertises; an unknown
        // value makes Devin reject `session/set_config_option`, so fall back to
        // the session's current model instead of failing the request.
        const requestedModel = modelSelection.model?.trim();
        if (requestedModel && requestedModel !== DEVIN_DEFAULT_MODEL_SLUG) {
          const configOptions = yield* runtime.getConfigOptions;
          const modelOption = configOptions.find(
            (option) => option.id === "model" && option.type === "select",
          );
          const advertised =
            modelOption?.type === "select"
              ? modelOption.options.flatMap((entry) =>
                  "value" in entry
                    ? [entry.value.trim()]
                    : entry.options.map((option) => option.value.trim()),
                )
              : [];
          if (
            advertised.includes(requestedModel) &&
            isRecord(modelOption) &&
            modelOption.currentValue !== requestedModel
          ) {
            yield* Effect.ignore(runtime.setConfigOption("model", requestedModel));
          }
        }

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        // Text-generation sessions are throwaway; dropping them keeps
        // `devin list` clean. Runs on success, failure, or timeout.
        Effect.ensuring(
          Effect.ignore(runtime.request("session/delete", { sessionId: started.sessionId })),
        ),
        Effect.timeoutOption(DEVIN_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Devin request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Devin ACP request failed.",
                cause,
              }),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Devin ACP request was cancelled."
              : "Devin returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Devin returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Devin ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("DevinTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runDevinJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("DevinTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runDevinJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("DevinTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runDevinJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("DevinTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runDevinJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
