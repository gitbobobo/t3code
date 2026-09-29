import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { devinUserStatusToLimits, readDevinUsageLimits } from "./devinUsageLimits.ts";

const CHECKED_AT = "2026-09-30T00:00:00.000Z";

const QUOTA_RESPONSE = {
  userStatus: {
    email: "user@example.com",
    planStatus: {
      planInfo: {
        planName: "Max",
        billingStrategy: "BILLING_STRATEGY_QUOTA",
        hideDailyQuota: true,
      },
      planStart: "2026-09-23T05:13:28Z",
      planEnd: "2026-10-23T05:13:28Z",
      availablePromptCredits: -1,
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 68,
      overageBalanceMicros: "-5750493",
      dailyQuotaResetAtUnix: "1790582400",
      weeklyQuotaResetAtUnix: "1791100800",
    },
  },
  planInfo: {
    planName: "Max",
    billingStrategy: "BILLING_STRATEGY_QUOTA",
    hideDailyQuota: true,
  },
};

const requestBody = (request: HttpClientRequest.HttpClientRequest) =>
  JSON.parse(request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "");

describe("devinUserStatusToLimits", () => {
  it("maps only the windows the plan does not hide", () => {
    const limits = devinUserStatusToLimits(QUOTA_RESPONSE, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 32,
        resetsAt: "2026-10-04T08:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("reports an exhausted window the response omits the percentage for", () => {
    const limits = devinUserStatusToLimits(
      {
        userStatus: {
          planStatus: {
            planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA" },
            dailyQuotaRemainingPercent: 40,
            dailyQuotaResetAtUnix: "1790582400",
            weeklyQuotaResetAtUnix: "1791100800",
          },
        },
      },
      CHECKED_AT,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "daily",
        kind: "session",
        label: "Daily",
        usedPercent: 60,
        resetsAt: "2026-09-28T08:00:00.000Z",
        windowDurationMins: 1440,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        resetsAt: "2026-10-04T08:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("treats non-quota plans as unsupported", () => {
    for (const response of [
      {},
      { planInfo: { billingStrategy: "BILLING_STRATEGY_UNSPECIFIED" } },
      {
        userStatus: { planStatus: { dailyQuotaRemainingPercent: 50 } },
        planInfo: { billingStrategy: "BILLING_STRATEGY_CREDITS" },
      },
    ]) {
      const limits = devinUserStatusToLimits(response, CHECKED_AT);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }
  });
});

it.layer(NodeServices.layer)("readDevinUsageLimits", (it) => {
  it.effect("reads the stored CLI login and its configured API server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(directory, "devin"));
      yield* fs.writeFileString(
        path.join(directory, "devin", "credentials.toml"),
        [
          'windsurf_api_key = "stored-key"',
          'api_server_url = "https://server.example.test/"',
          'devin_api_url = "https://api.devin.ai"',
        ].join("\n"),
      );
      const limits = yield* readDevinUsageLimits({
        XDG_DATA_HOME: directory,
        HOME: "/unrelated-home",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe(
              "https://server.example.test/exa.seat_management_pb.SeatManagementService/GetUserStatus",
            );
            expect(request.headers["connect-protocol-version"]).toBe("1");
            const body = requestBody(request);
            expect(body.metadata.apiKey).toBe("stored-key");
            expect(body.metadata.ideName).toBe("t3code");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json(QUOTA_RESPONSE)),
            );
          }),
        ),
      );
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toEqual([
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 32,
          resetsAt: "2026-10-04T08:00:00.000Z",
          windowDurationMins: 10080,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "uses WINDSURF_API_KEY and WINDSURF_API_SERVER_URL without reading the login file",
    () =>
      readDevinUsageLimits({
        WINDSURF_API_KEY: "env-key",
        WINDSURF_API_SERVER_URL: "https://env.example.test",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("must not read stored credentials"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe(
              "https://env.example.test/exa.seat_management_pb.SeatManagementService/GetUserStatus",
            );
            expect(requestBody(request).metadata.apiKey).toBe("env-key");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json(QUOTA_RESPONSE)),
            );
          }),
        ),
        Effect.tap((limits) => Effect.sync(() => expect(limits.windows[0]?.usedPercent).toBe(32))),
      ),
  );

  it.effect("reports unsupported without a login and never asks the server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const limits = yield* readDevinUsageLimits({
        XDG_DATA_HOME: directory,
        HOME: "/unrelated-home",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request quota without a login")),
        ),
      );
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("reports probeFailed when the quota request or its body fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(directory, "devin"));
      yield* fs.writeFileString(
        path.join(directory, "devin", "credentials.toml"),
        'windsurf_api_key = "stored-key"',
      );
      for (const respond of [
        () => new Response("unauthorized", { status: 401 }),
        () =>
          Response.json({
            userStatus: {
              planStatus: {
                planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA" },
                weeklyQuotaRemainingPercent: "private",
              },
            },
          }),
      ]) {
        const limits = yield* readDevinUsageLimits({
          XDG_DATA_HOME: directory,
          HOME: "/unrelated-home",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, respond())),
            ),
          ),
        );
        expect(limits.windows).toEqual([]);
        expect(limits.unavailable).toEqual({
          reason: "probeFailed",
          message: "Devin could not read usage limits.",
        });
      }
    }).pipe(Effect.scoped),
  );
});
