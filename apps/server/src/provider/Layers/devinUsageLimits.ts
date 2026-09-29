import * as NodeOS from "node:os";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";
import packageJson from "../../../package.json" with { type: "json" };

const DEFAULT_DEVIN_API_SERVER = "https://server.codeium.com";

const DevinPlanInfo = Schema.Struct({
  billingStrategy: Schema.optional(Schema.String),
  hideDailyQuota: Schema.optional(Schema.Boolean),
  hideWeeklyQuota: Schema.optional(Schema.Boolean),
});
// Connect's JSON codec follows proto3: int64 fields arrive as strings, and
// zero values are omitted entirely.
const DevinUserStatusResponse = Schema.Struct({
  userStatus: Schema.optional(
    Schema.Struct({
      planStatus: Schema.optional(
        Schema.Struct({
          planInfo: Schema.optional(DevinPlanInfo),
          dailyQuotaRemainingPercent: Schema.optional(Schema.Number),
          weeklyQuotaRemainingPercent: Schema.optional(Schema.Number),
          dailyQuotaResetAtUnix: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          weeklyQuotaResetAtUnix: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
        }),
      ),
    }),
  ),
  planInfo: Schema.optional(DevinPlanInfo),
});

function isoFromEpochSeconds(value: string | number | undefined): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const dt = DateTime.make(seconds * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

export function devinUserStatusToLimits(
  response: typeof DevinUserStatusResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const planStatus = response.userStatus?.planStatus;
  const plan = planStatus?.planInfo ?? response.planInfo;
  if (!planStatus || plan?.billingStrategy !== "BILLING_STRATEGY_QUOTA") {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const windows: ServerProviderUsageWindow[] = [];
  // The daily window reports as "session" so the shorter window sorts first.
  for (const spec of [
    {
      id: "daily",
      kind: "session",
      label: "Daily",
      windowDurationMins: 1440,
      hidden: plan.hideDailyQuota,
      remainingPercent: planStatus.dailyQuotaRemainingPercent,
      resetAtUnix: planStatus.dailyQuotaResetAtUnix,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 10080,
      hidden: plan.hideWeeklyQuota,
      remainingPercent: planStatus.weeklyQuotaRemainingPercent,
      resetAtUnix: planStatus.weeklyQuotaResetAtUnix,
    },
  ] as const) {
    if (spec.hidden) continue;
    const resetsAt = isoFromEpochSeconds(spec.resetAtUnix);
    // Connect JSON omits zero values, so an exhausted window arrives with no
    // percentage; a window with neither a percentage nor a reset is not
    // reported at all.
    if (spec.remainingPercent === undefined && resetsAt === undefined) continue;
    windows.push({
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      windowDurationMins: spec.windowDurationMins,
      usedPercent: clampPercent(100 - (spec.remainingPercent ?? 0)),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

function readTomlValue(contents: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m").exec(contents);
  return match?.[1]?.trim() || undefined;
}

/**
 * Reads the Devin CLI login once and reports its subscription quota windows.
 * `WINDSURF_API_KEY` counts as the login the session uses; otherwise the key
 * comes from the CLI's `credentials.toml` under the XDG data home.
 */
export const readDevinUsageLimits = Effect.fn("readDevinUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Devin could not read usage limits.",
  });
  return yield* Effect.gen(function* () {
    let apiKey = environment.WINDSURF_API_KEY?.trim();
    let storedServerUrl: string | undefined;
    // An explicit key picks its own session identity; the credentials file is
    // only read when no key is set.
    if (!apiKey) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
      const dataHome = environment.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
      const credentials = yield* fs
        .readFileString(path.join(dataHome, "devin", "credentials.toml"))
        .pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
          }),
        );
      apiKey = readTomlValue(credentials, "windsurf_api_key");
      storedServerUrl = readTomlValue(credentials, "api_server_url");
    }
    if (!apiKey) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const server = (
      environment.WINDSURF_API_SERVER_URL?.trim() ||
      storedServerUrl ||
      DEFAULT_DEVIN_API_SERVER
    ).replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(
        `${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      ).pipe(
        HttpClientRequest.setHeaders({ "connect-protocol-version": "1" }),
        HttpClientRequest.bodyJsonUnsafe({
          metadata: {
            apiKey,
            ideName: "t3code",
            ideVersion: packageJson.version,
            extensionName: "t3code",
            extensionVersion: packageJson.version,
            locale: "en",
          },
        }),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(DevinUserStatusResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return devinUserStatusToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed),
  );
});
