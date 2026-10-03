import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { CheckCircle2, ClockIcon, MonitorSmartphoneIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  selectVisibleSidebarDeviceCards,
  type SidebarDeviceCountsState,
  type SidebarDeviceStatusCounts,
  type SidebarThreadStatus,
} from "./SidebarDeviceScope.logic";
import { connectionPhaseDotClassName } from "./ConnectionStatusDot";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";

// Two rows of two cards before the grid overflows into "Expand all". The
// collapsed window always keeps the selected card visible.
const SIDEBAR_DEVICE_GRID_VISIBLE_CARDS = 4;

/** Display order: needs-attention first, then motion, then the resting
    state — the same priority reading the row pills use. */
const DEVICE_STATUS_ORDER: readonly SidebarThreadStatus[] = [
  "approval",
  "input",
  "working",
  "waiting",
  "failed",
  "limited",
  "ready",
];

const DEVICE_STATUS_LABELS: Record<SidebarThreadStatus, string> = {
  approval: "pending approval",
  input: "awaiting input",
  working: "working",
  waiting: "waiting",
  failed: "failed",
  limited: "usage limited",
  ready: "ready",
};

// Semantic colors follow the client's theme for attention, work, and failure.
const DEVICE_STATUS_DOT_CLASS_NAMES: Record<SidebarThreadStatus, string> = {
  approval: "bg-warning",
  input: "bg-primary",
  working: "bg-info",
  waiting: "bg-muted-foreground/40",
  failed: "bg-destructive",
  limited: "bg-warning",
  ready: "bg-muted-foreground/40",
};

export interface SidebarDeviceCard {
  /** Environment id, or null for the roll-up card. */
  readonly key: string | null;
  readonly label: string;
  /** Null on the "All environments" card, which has no single machine glyph. */
  readonly machine: EnvironmentMachineKind | null;
  readonly connectionPhase: EnvironmentConnectionPhase | null;
  readonly countsState: SidebarDeviceCountsState;
}

function deviceStatusChips(
  counts: SidebarDeviceStatusCounts,
): { readonly status: SidebarThreadStatus; readonly count: number }[] {
  return DEVICE_STATUS_ORDER.flatMap((status) =>
    counts[status] > 0 ? [{ status, count: counts[status] }] : [],
  );
}

function compactSyncAgeLabel(syncedAt: string): string | null {
  const ageMs = Date.now() - Date.parse(syncedAt);
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < 0) return "now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The counts row, plus the card's tooltip text: cached totals are labelled
    with their sync age and the roll-up admits incomplete data instead of
    presenting it as live. */
function deviceCountsRow(countsState: SidebarDeviceCountsState): {
  readonly row: ReactNode;
  readonly tooltip: string;
} {
  if (countsState.kind === "loading") {
    return {
      row: <span className="truncate text-3xs text-sidebar-muted-foreground/60">Syncing…</span>,
      tooltip: "Syncing…",
    };
  }
  if (countsState.kind === "unknown") {
    return {
      row: (
        <span className="truncate text-3xs text-sidebar-muted-foreground/60">Counts unknown</span>
      ),
      tooltip: "Counts unknown",
    };
  }
  const isCached = countsState.kind === "cached";
  const isSynchronizing = countsState.kind === "synchronizing";
  const syncAge = isCached || isSynchronizing ? compactSyncAgeLabel(countsState.syncedAt) : null;
  const statePrefix = isCached
    ? syncAge === null
      ? "Offline · cached counts"
      : `Offline · last synced ${syncAge} ago`
    : isSynchronizing
      ? syncAge === null
        ? "Syncing · cached counts"
        : `Syncing · last synced ${syncAge} ago`
      : countsState.kind === "mixed"
        ? countsState.hasCachedData && !countsState.isComplete
          ? "Includes cached data · statistics incomplete"
          : countsState.hasCachedData
            ? "Includes cached data"
            : "Statistics incomplete"
        : null;
  const chips = deviceStatusChips(countsState.counts);
  const summary = chips
    .map(({ status, count }) => `${count} ${DEVICE_STATUS_LABELS[status]}`)
    .join(", ");
  const completedSummary =
    countsState.counts.completed > 0 ? `${countsState.counts.completed} completed` : null;
  if (chips.length === 0 && completedSummary === null) {
    return {
      row: (
        <span className="text-3xs text-sidebar-muted-foreground/60">
          {statePrefix ?? "No threads"}
        </span>
      ),
      tooltip: statePrefix ?? "No threads",
    };
  }
  return {
    row: (
      <span className="flex min-w-0 items-center gap-1.5">
        {statePrefix !== null ? (
          <span aria-hidden className="shrink-0 text-sidebar-muted-foreground/60">
            <ClockIcon className="size-2.5" />
          </span>
        ) : null}
        {chips.map(({ status, count }) => (
          <span
            key={status}
            className="flex items-center gap-0.5 font-mono text-3xs leading-none tabular-nums text-sidebar-muted-foreground"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                DEVICE_STATUS_DOT_CLASS_NAMES[status],
              )}
            />
            {count}
          </span>
        ))}
        {completedSummary !== null ? (
          <span className="flex items-center gap-0.5 font-mono text-3xs leading-none tabular-nums text-sidebar-muted-foreground">
            <CheckCircle2 aria-hidden className="size-2.5 text-success" />
            {countsState.counts.completed}
          </span>
        ) : null}
      </span>
    ),
    tooltip:
      statePrefix === null
        ? [summary, completedSummary].filter(Boolean).join(", ")
        : `${statePrefix} · ${[summary, completedSummary].filter(Boolean).join(", ")}`,
  };
}

export function SidebarDeviceGrid(props: {
  readonly cards: readonly SidebarDeviceCard[];
  /** The selected card key, or null for "All environments". */
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasOverflow = props.cards.length > SIDEBAR_DEVICE_GRID_VISIBLE_CARDS;
  const { visible } = selectVisibleSidebarDeviceCards(
    props.cards,
    isExpanded ? props.cards.length : SIDEBAR_DEVICE_GRID_VISIBLE_CARDS,
    (card) => card.key === props.selectedKey,
  );
  return (
    <div className="flex flex-col gap-1">
      <div
        role="group"
        aria-label="Filter threads by environment"
        className="grid grid-cols-2 gap-1"
      >
        {visible.map((card) => {
          const isSelected = card.key === props.selectedKey;
          const { row, tooltip } = deviceCountsRow(card.countsState);
          return (
            <Tooltip key={card.key ?? "all-environments"}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${card.label}: ${tooltip}`}
                    onClick={() => props.onSelect(isSelected ? null : card.key)}
                    className={cn(
                      "flex min-w-0 cursor-pointer flex-col gap-1 rounded-md border px-1.5 py-1 text-left transition-colors",
                      isSelected
                        ? "border-transparent bg-sidebar-row-active text-sidebar-foreground"
                        : "border-sidebar-border/70 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {card.machine ? (
                        <EnvironmentMachineIcon
                          kind={card.machine}
                          className="size-3.5 shrink-0 opacity-80"
                        />
                      ) : (
                        <MonitorSmartphoneIcon
                          aria-hidden
                          className="size-3.5 shrink-0 opacity-80"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs leading-none font-medium">
                        {card.label}
                      </span>
                      {card.connectionPhase &&
                      card.connectionPhase !== "connected" &&
                      card.connectionPhase !== "available" ? (
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            connectionPhaseDotClassName(card.connectionPhase),
                          )}
                        />
                      ) : null}
                    </span>
                    {row}
                  </button>
                }
              />
              <TooltipPopup side="right">{tooltip}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      {hasOverflow ? (
        <button
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          className="cursor-pointer text-left text-2xs font-medium text-sidebar-muted-foreground/55 transition-colors hover:text-sidebar-foreground"
        >
          {isExpanded
            ? "Show fewer environments"
            : `Expand all environments (${props.cards.length})`}
        </button>
      ) : null}
    </div>
  );
}
