import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { SidebarThreadSummary } from "../types";

import {
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
  type SidebarThreadStatusInput,
} from "./Sidebar.logic";

export type { SidebarThreadStatus } from "./Sidebar.logic";

export type SidebarDeviceStatusCounts = Readonly<Record<SidebarThreadStatus, number>>;

/** Resolve the only device scope that the new sidebar is allowed to expose.
 * Persisted keys may outlive an environment, and the legacy sidebar shares
 * the same store, so every new-thread entry point must use this result. */
export function resolveSidebarDeviceScope(input: {
  readonly enabled: boolean;
  readonly catalogReady: boolean;
  readonly environmentIds: readonly string[];
  readonly requestedEnvironmentId: string | null;
}): string | null {
  if (!input.enabled || !input.catalogReady || input.environmentIds.length <= 1) return null;
  if (input.requestedEnvironmentId === null) return null;
  return input.environmentIds.includes(input.requestedEnvironmentId)
    ? input.requestedEnvironmentId
    : null;
}

/** Selected-device creation is the one implicit creation path that must honor
 * connection readiness. Explicit project/worktree actions use the underlying
 * handler directly and keep their existing semantics. */
export function canCreateThreadInSidebarDeviceScope(input: {
  readonly scopeEnvironmentId: string | null;
  readonly projectEnvironmentIds: readonly string[];
  readonly connectionPhase: EnvironmentConnectionPhase | null | undefined;
}): boolean {
  return (
    input.scopeEnvironmentId === null ||
    (input.connectionPhase === "connected" &&
      input.projectEnvironmentIds.includes(input.scopeEnvironmentId))
  );
}

export function createEmptySidebarDeviceStatusCounts(): SidebarDeviceStatusCounts {
  return { approval: 0, input: 0, working: 0, monitoring: 0, failed: 0, ready: 0 };
}

export function countSidebarThreadsByDevice<
  TThread extends SidebarThreadStatusInput & {
    readonly environmentId: string;
    readonly archivedAt: string | null;
    readonly settledOverride: SidebarThreadSummary["settledOverride"];
  },
>(threads: readonly TThread[]): ReadonlyMap<string, SidebarDeviceStatusCounts> {
  const countsByEnvironment = new Map<string, SidebarDeviceStatusCounts>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
    const counts: Record<SidebarThreadStatus, number> = {
      ...(countsByEnvironment.get(thread.environmentId) ?? createEmptySidebarDeviceStatusCounts()),
    };
    counts[resolveSidebarThreadStatus(thread)] += 1;
    countsByEnvironment.set(thread.environmentId, counts);
  }
  return countsByEnvironment;
}

/** Whether the card's numbers are current, cached, or missing entirely. The
 * grid must never present cached counts as live, or a never-synced
 * environment's absence of data as zero. */
export type SidebarDeviceCountsState =
  | { readonly kind: "live"; readonly counts: SidebarDeviceStatusCounts }
  | {
      readonly kind: "cached";
      readonly counts: SidebarDeviceStatusCounts;
      readonly syncedAt: string;
    }
  | {
      readonly kind: "synchronizing";
      readonly counts: SidebarDeviceStatusCounts;
      readonly syncedAt: string;
    }
  | {
      readonly kind: "mixed";
      readonly counts: SidebarDeviceStatusCounts;
      /** Cached data and completeness are independent trust signals. */
      readonly hasCachedData: boolean;
      readonly isComplete: boolean;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "unknown" };

export function resolveSidebarDeviceCountsState(input: {
  readonly shellStatus: "empty" | "cached" | "synchronizing" | "live";
  readonly hasSnapshot: boolean;
  readonly counts: SidebarDeviceStatusCounts | null;
  readonly snapshotUpdatedAt: string | null;
}): SidebarDeviceCountsState {
  if (input.counts !== null && input.hasSnapshot) {
    const syncedAt = input.snapshotUpdatedAt ?? "";
    if (input.shellStatus === "synchronizing") {
      // A snapshot can be old while a new stream is still incomplete. Keep
      // its numbers, but carry that uncertainty into the card and aggregate.
      return { kind: "synchronizing", counts: input.counts, syncedAt };
    }
    return input.shellStatus === "cached"
      ? { kind: "cached", counts: input.counts, syncedAt }
      : { kind: "live", counts: input.counts };
  }
  return input.shellStatus === "synchronizing" ? { kind: "loading" } : { kind: "unknown" };
}

export function sumSidebarStatusCounts(
  countsList: readonly SidebarDeviceStatusCounts[],
): SidebarDeviceStatusCounts {
  const total: Record<SidebarThreadStatus, number> = createEmptySidebarDeviceStatusCounts();
  for (const counts of countsList) {
    for (const status of Object.keys(counts) as SidebarThreadStatus[]) {
      total[status] += counts[status];
    }
  }
  return total;
}

/** "All devices" rolls up every card, cached data included. A "mixed" total
 * carries the summed counts plus a trust hint instead of pretending the
 * numbers are complete. */
export function resolveAllDevicesCountsState(
  states: readonly SidebarDeviceCountsState[],
): SidebarDeviceCountsState {
  const available = states.flatMap((state) => (state.kind === "loading" ? [] : [state]));
  if (available.every((state) => state.kind === "unknown")) return { kind: "unknown" };
  const hasCached = available.some(
    (state) => state.kind === "cached" || state.kind === "synchronizing",
  );
  const hasUnknown = available.some((state) => state.kind === "unknown");
  const hasLoading = states.some((state) => state.kind === "loading");
  const counts = sumSidebarStatusCounts(
    available.flatMap((state) => (state.kind === "unknown" ? [] : [state.counts])),
  );
  const hasSynchronizing = available.some((state) => state.kind === "synchronizing");
  if (hasCached || hasUnknown || hasLoading) {
    return {
      kind: "mixed",
      counts,
      hasCachedData: hasCached,
      isComplete: !hasUnknown && !hasLoading && !hasSynchronizing,
    };
  }
  return { kind: "live", counts };
}

/** Collapsed two-row grid: the first cards win their slots, but a selected
 * card deeper in the list must stay reachable, so it swaps into the window. */
export function selectVisibleSidebarDeviceCards<TCard>(
  cards: readonly TCard[],
  limit: number,
  isSelected: (card: TCard) => boolean,
): { readonly visible: readonly TCard[]; readonly isTruncated: boolean } {
  if (cards.length <= limit) {
    return { visible: cards, isTruncated: false };
  }
  const selectedIndex = cards.findIndex(isSelected);
  if (selectedIndex === -1 || selectedIndex < limit) {
    return { visible: cards.slice(0, limit), isTruncated: true };
  }
  const visible = [...cards.slice(0, limit - 1), cards[selectedIndex]!];
  return { visible, isTruncated: true };
}

export function sidebarProjectGroupServesEnvironment(
  memberProjectRefs: readonly { readonly environmentId: string }[],
  environmentId: string | null,
): boolean {
  return (
    environmentId === null ||
    memberProjectRefs.some((projectRef) => projectRef.environmentId === environmentId)
  );
}
