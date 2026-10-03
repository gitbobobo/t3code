import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type SidebarThreadSummary } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  canCreateThreadInSidebarDeviceScope,
  countSidebarThreadsByDevice,
  createEmptySidebarDeviceStatusCounts,
  resolveAllDevicesCountsState,
  resolveSidebarDeviceCountsState,
  resolveSidebarDeviceScope,
  selectVisibleSidebarDeviceCards,
  sidebarProjectGroupServesEnvironment,
  type SidebarDeviceStatusCounts,
} from "./SidebarDeviceScope.logic";

// ── Sidebar device scope ────────────────────────────────────────────

describe("resolveSidebarDeviceScope", () => {
  it("disables filtering for one environment, legacy mode, and a missing key", () => {
    const input = {
      enabled: true,
      catalogReady: true,
      environmentIds: ["env-a"],
      requestedEnvironmentId: "env-a",
    };
    expect(resolveSidebarDeviceScope(input)).toBeNull();
    expect(
      resolveSidebarDeviceScope({ ...input, enabled: false, environmentIds: ["env-a", "env-b"] }),
    ).toBeNull();
    expect(
      resolveSidebarDeviceScope({
        ...input,
        environmentIds: ["env-a", "env-b"],
        requestedEnvironmentId: "env-gone",
      }),
    ).toBeNull();
  });

  it("returns only a ready, catalog-backed selected environment", () => {
    expect(
      resolveSidebarDeviceScope({
        enabled: true,
        catalogReady: true,
        environmentIds: ["env-a", "env-b"],
        requestedEnvironmentId: "env-b",
      }),
    ).toBe("env-b");
    expect(
      resolveSidebarDeviceScope({
        enabled: true,
        catalogReady: false,
        environmentIds: ["env-a", "env-b"],
        requestedEnvironmentId: "env-b",
      }),
    ).toBeNull();
  });
});

describe("canCreateThreadInSidebarDeviceScope", () => {
  it("keeps all-devices creation on existing rules", () => {
    expect(
      canCreateThreadInSidebarDeviceScope({
        scopeEnvironmentId: null,
        projectEnvironmentIds: [],
        connectionPhase: "offline",
      }),
    ).toBe(true);
  });

  it("requires a project and a connected selected device", () => {
    const input = {
      scopeEnvironmentId: "env-a",
      projectEnvironmentIds: ["env-a"],
      connectionPhase: "connected" as const,
    };
    expect(canCreateThreadInSidebarDeviceScope(input)).toBe(true);
    expect(canCreateThreadInSidebarDeviceScope({ ...input, connectionPhase: "offline" })).toBe(
      false,
    );
    expect(
      canCreateThreadInSidebarDeviceScope({ ...input, projectEnvironmentIds: ["env-b"] }),
    ).toBe(false);
  });
});

describe("countSidebarThreadsByDevice", () => {
  const runningRuntime = {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: RunId.make("run-1"),
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const thread = (overrides: {
    environmentId: string;
    archivedAt?: string | null;
    settledOverride?: "settled" | "active" | null;
    status?: "running" | "error";
    hasPendingApprovals?: boolean;
    hasPendingUserInput?: boolean;
  }) =>
    makeThreadFixture({
      id: ThreadId.make("thread-1"),
      runtime:
        overrides.status === undefined
          ? null
          : {
              ...runningRuntime,
              status: overrides.status === "error" ? "failed" : overrides.status,
            },
      hasPendingApprovals: overrides.hasPendingApprovals ?? false,
      hasPendingUserInput: overrides.hasPendingUserInput ?? false,
      environmentId: overrides.environmentId as SidebarThreadSummary["environmentId"],
      archivedAt: overrides.archivedAt ?? null,
      settledOverride: overrides.settledOverride ?? null,
    });
  const doneRun: SidebarThreadSummary["latestRun"] = {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: "2026-03-09T09:59:00.000Z",
    startedAt: "2026-03-09T09:59:30.000Z",
    completedAt: "2026-03-09T10:00:00.000Z",
    assistantMessageId: null,
  };
  const visitKey = (environmentId: string) =>
    scopedThreadKey(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make("thread-1")));

  it("tallies each device's threads into the row resolver's statuses", () => {
    const counts = countSidebarThreadsByDevice([
      thread({ environmentId: "env-a", hasPendingApprovals: true }),
      thread({ environmentId: "env-a", status: "running" }),
      thread({ environmentId: "env-a" }),
      thread({ environmentId: "env-b", status: "error" }),
    ]);

    expect(counts.get("env-a")).toEqual({
      approval: 1,
      input: 0,
      working: 1,
      waiting: 0,
      failed: 0,
      limited: 0,
      ready: 1,
      completed: 0,
    });
    expect(counts.get("env-b")?.failed).toBe(1);
  });

  it("applies the resolver's priority so a thread lands in exactly one status", () => {
    const counts = countSidebarThreadsByDevice([
      thread({ environmentId: "env-a", status: "running", hasPendingApprovals: true }),
    ]);

    expect(counts.get("env-a")?.approval).toBe(1);
    expect(counts.get("env-a")?.working).toBe(0);
  });

  it("never counts archived threads", () => {
    const counts = countSidebarThreadsByDevice([
      thread({ environmentId: "env-a", archivedAt: "2026-03-09T09:00:00.000Z" }),
      thread({ environmentId: "env-a" }),
    ]);

    expect(counts.get("env-a")?.ready).toBe(1);
    expect(counts.get("env-a")?.approval).toBe(0);
  });

  it("excludes settled threads from device counts and the all-devices total", () => {
    const counts = countSidebarThreadsByDevice([
      thread({ environmentId: "env-a", settledOverride: "settled", status: "running" }),
      thread({ environmentId: "env-a", settledOverride: "active", status: "running" }),
      thread({ environmentId: "env-b", settledOverride: "settled", hasPendingApprovals: true }),
      thread({ environmentId: "env-b" }),
    ]);
    expect(counts.get("env-a")?.working).toBe(1);
    expect(counts.get("env-b")?.approval).toBe(0);
    expect(
      resolveAllDevicesCountsState(
        [...counts.values()].map((counts) => ({ kind: "live", counts })),
      ),
    ).toEqual({
      kind: "live",
      counts: { ...createEmptySidebarDeviceStatusCounts(), working: 1, ready: 1 },
    });
  });

  it("counts a thread again after it is unsettled", () => {
    const settled = thread({ environmentId: "env-a", settledOverride: "settled" });
    expect(countSidebarThreadsByDevice([settled]).size).toBe(0);
    expect(
      countSidebarThreadsByDevice([{ ...settled, settledOverride: "active" }]).get("env-a")?.ready,
    ).toBe(1);
  });

  it("tallies unseen completions as done instead of ready", () => {
    const doneThread = {
      ...thread({ environmentId: "env-a" }),
      latestRun: doneRun,
      lastVisitedAt: "2026-03-09T09:00:00.000Z",
    };

    const unseen = countSidebarThreadsByDevice([doneThread], {
      [visitKey("env-a")]: "2026-03-09T09:00:00.000Z",
    });
    expect(unseen.get("env-a")?.completed).toBe(1);
    expect(unseen.get("env-a")?.ready).toBe(0);

    // Visiting past the completion returns the thread to quiet ready.
    const seen = countSidebarThreadsByDevice(
      [
        {
          ...doneThread,
          lastVisitedAt: "2026-03-09T11:00:00.000Z",
        },
      ],
      {
        [visitKey("env-a")]: "2026-03-09T11:00:00.000Z",
      },
    );
    expect(seen.get("env-a")?.completed).toBe(0);
    expect(seen.get("env-a")?.ready).toBe(1);
  });

  it("keeps an unseen completion of an action-required thread out of done", () => {
    const approvalThread = {
      ...thread({ environmentId: "env-a", hasPendingApprovals: true }),
      latestRun: doneRun,
    };
    const counts = countSidebarThreadsByDevice([approvalThread], {
      [visitKey("env-a")]: "2026-03-09T09:00:00.000Z",
    });
    expect(counts.get("env-a")?.approval).toBe(1);
    expect(counts.get("env-a")?.completed).toBe(0);
  });

  it("uses the server visit marker even when the local marker is newer", () => {
    const counts = countSidebarThreadsByDevice(
      [
        {
          ...thread({ environmentId: "env-a" }),
          latestRun: doneRun,
          lastVisitedAt: "2026-03-09T09:00:00.000Z",
        },
      ],
      {
        [visitKey("env-a")]: "2026-03-09T11:00:00.000Z",
      },
    );
    expect(counts.get("env-a")?.completed).toBe(1);
  });

  it("counts waiting and usage-limited runtimes separately", () => {
    const base = thread({ environmentId: "env-a" });
    const counts = countSidebarThreadsByDevice([
      { ...base, runtime: { ...runningRuntime, status: "idle" } },
      { ...base, runtime: { ...runningRuntime, status: "failed", lastErrorClass: "usage_limit" } },
    ]);
    expect(counts.get("env-a")?.waiting).toBe(1);
    expect(counts.get("env-a")?.limited).toBe(1);
    expect(counts.get("env-a")?.failed).toBe(0);
  });

  it("does not count subagent threads that are hidden from the sidebar", () => {
    const base = thread({ environmentId: "env-a" });
    const counts = countSidebarThreadsByDevice([
      {
        ...base,
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      },
    ]);
    expect(counts.size).toBe(0);
  });

  it("returns an empty tally when there is nothing to count", () => {
    expect(countSidebarThreadsByDevice([]).size).toBe(0);
  });
});

describe("resolveSidebarDeviceCountsState", () => {
  const counts = createEmptySidebarDeviceStatusCounts();

  it("treats a live shell as current but preserves synchronizing uncertainty", () => {
    expect(
      resolveSidebarDeviceCountsState({
        shellStatus: "live",
        hasSnapshot: true,
        counts,
        snapshotUpdatedAt: "2026-03-09T10:00:00.000Z",
      }).kind,
    ).toBe("live");
    expect(
      resolveSidebarDeviceCountsState({
        shellStatus: "synchronizing",
        hasSnapshot: true,
        counts,
        snapshotUpdatedAt: "2026-03-09T10:00:00.000Z",
      }).kind,
    ).toBe("synchronizing");
  });

  it("labels a disconnected shell's snapshot as cached with its sync age", () => {
    const state = resolveSidebarDeviceCountsState({
      shellStatus: "cached",
      hasSnapshot: true,
      counts,
      snapshotUpdatedAt: "2026-03-09T10:00:00.000Z",
    });

    expect(state).toEqual({
      kind: "cached",
      counts,
      syncedAt: "2026-03-09T10:00:00.000Z",
    });
  });

  it("keeps a first synchronization honest instead of reporting zero", () => {
    expect(
      resolveSidebarDeviceCountsState({
        shellStatus: "synchronizing",
        hasSnapshot: false,
        counts: null,
        snapshotUpdatedAt: null,
      }).kind,
    ).toBe("loading");
  });

  it("reports counts unknown before the first sync completes", () => {
    expect(
      resolveSidebarDeviceCountsState({
        shellStatus: "empty",
        hasSnapshot: false,
        counts: null,
        snapshotUpdatedAt: null,
      }).kind,
    ).toBe("unknown");
  });
});

describe("resolveAllDevicesCountsState", () => {
  const counts = (overrides: Partial<SidebarDeviceStatusCounts>) => ({
    approval: 0,
    input: 0,
    working: 0,
    waiting: 0,
    failed: 0,
    limited: 0,
    ready: 0,
    completed: 0,
    ...overrides,
  });

  it("sums live cards into one live total", () => {
    expect(
      resolveAllDevicesCountsState([
        { kind: "live", counts: counts({ ready: 1, working: 2 }) },
        { kind: "live", counts: counts({ ready: 3 }) },
      ]),
    ).toEqual({ kind: "live", counts: counts({ ready: 4, working: 2 }) });
  });

  it("rolls cached data into the total but flags the mix", () => {
    expect(
      resolveAllDevicesCountsState([
        { kind: "live", counts: counts({ working: 1 }) },
        { kind: "cached", counts: counts({ ready: 5 }), syncedAt: "2026-03-09T10:00:00.000Z" },
      ]),
    ).toEqual({
      kind: "mixed",
      counts: counts({ working: 1, ready: 5 }),
      hasCachedData: true,
      isComplete: true,
    });
  });

  it("flags the total incomplete while any device's counts are unknown", () => {
    expect(
      resolveAllDevicesCountsState([
        { kind: "live", counts: counts({ working: 1 }) },
        { kind: "unknown" },
      ]),
    ).toEqual({
      kind: "mixed",
      counts: counts({ working: 1 }),
      hasCachedData: false,
      isComplete: false,
    });
    expect(resolveAllDevicesCountsState([{ kind: "unknown" }])).toEqual({ kind: "unknown" });
  });

  it("lets a still-loading device contribute nothing rather than zero", () => {
    expect(
      resolveAllDevicesCountsState([
        { kind: "loading" },
        { kind: "live", counts: counts({ ready: 2 }) },
      ]),
    ).toEqual({
      kind: "mixed",
      counts: counts({ ready: 2 }),
      hasCachedData: false,
      isComplete: false,
    });
  });
});

describe("selectVisibleSidebarDeviceCards", () => {
  const cards = [null, "env-a", "env-b", "env-c", "env-d", "env-e"];

  it("shows every card without a toggle when the grid fits", () => {
    const { visible, isTruncated } = selectVisibleSidebarDeviceCards(
      cards.slice(0, 4),
      4,
      () => false,
    );

    expect(visible).toEqual([null, "env-a", "env-b", "env-c"]);
    expect(isTruncated).toBe(false);
  });

  it("collapses to the first row of cards and reports the overflow", () => {
    const { visible, isTruncated } = selectVisibleSidebarDeviceCards(cards, 4, () => false);

    expect(visible).toEqual([null, "env-a", "env-b", "env-c"]);
    expect(isTruncated).toBe(true);
  });

  it("keeps a selected card visible by swapping it into the collapsed window", () => {
    const { visible, isTruncated } = selectVisibleSidebarDeviceCards(
      cards,
      4,
      (card) => card === "env-e",
    );

    expect(visible).toHaveLength(4);
    expect(visible).toContain("env-e");
    expect(visible).toContain(null);
    expect(isTruncated).toBe(true);
  });
});

describe("sidebarProjectGroupServesEnvironment", () => {
  const members = [{ environmentId: "env-a" }, { environmentId: "env-b" }];

  it("serves every group when no device is selected", () => {
    expect(sidebarProjectGroupServesEnvironment(members, null)).toBe(true);
  });

  it("matches a group with a member on the selected device", () => {
    expect(sidebarProjectGroupServesEnvironment(members, "env-b")).toBe(true);
  });

  it("rejects a group with no member on the selected device", () => {
    expect(sidebarProjectGroupServesEnvironment(members, "env-c")).toBe(false);
  });
});
