import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { isHostedStaticApp } from "../hostedPairing";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

const NO_SHELL_STATUS_ATOM = Atom.make<EnvironmentShellStatus | null>(null).pipe(
  Atom.withLabel("web-environment-shell-status:none"),
);
const NO_SHELL_SNAPSHOT_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-environment-shell-has-snapshot:none"),
);

export function useEnvironmentShellStatus(
  environmentId: EnvironmentId | null,
): EnvironmentShellStatus | null {
  return useAtomValue(
    environmentId === null ? NO_SHELL_STATUS_ATOM : environmentShell.statusAtom(environmentId),
  );
}

export function useEnvironmentShellHasSnapshot(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_SHELL_SNAPSHOT_ATOM
      : environmentShell.hasSnapshotAtom(environmentId),
  );
}

let previousLiveEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();
/** Environments whose threads reflect the server now, not a cache or a resync in flight. */
export const liveShellEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set<EnvironmentId>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (get(environmentShell.statusAtom(environmentId)) === "live") next.add(environmentId);
  }
  if (
    next.size === previousLiveEnvironmentIds.size &&
    [...next].every((environmentId) => previousLiveEnvironmentIds.has(environmentId))
  ) {
    return previousLiveEnvironmentIds;
  }
  previousLiveEnvironmentIds = next;
  return next;
}).pipe(Atom.withLabel("web-live-shell-environment-ids"));

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

// Catalog can precede primary discovery; an empty or incomplete catalog cannot prove absence.
function catalogIsComplete(
  catalog: EnvironmentCatalogState,
  requiresPrimaryEnvironment: boolean,
): boolean {
  if (!catalog.isReady || catalog.entries.size === 0) return false;
  return (
    !requiresPrimaryEnvironment ||
    Array.from(catalog.entries.values()).some(
      (entry) => entry.target._tag === "PrimaryConnectionTarget",
    )
  );
}

export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogIsComplete(catalog, input.requiresPrimaryEnvironment)) return false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
    requiresPrimaryEnvironment: !isHostedStaticApp(),
  });

function shellStatesEqual(
  left: ReadonlyMap<EnvironmentId, EnvironmentShellState>,
  right: ReadonlyMap<EnvironmentId, EnvironmentShellState>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [environmentId, state] of left) {
    const other = right.get(environmentId);
    if (
      other === undefined ||
      other.status !== state.status ||
      other.snapshot !== state.snapshot ||
      other.error !== state.error
    ) {
      return false;
    }
  }
  return true;
}

const EMPTY_ENVIRONMENT_SHELL_STATES: ReadonlyMap<EnvironmentId, EnvironmentShellState> = new Map();

/** One map of every catalog environment's shell state, so aggregate UI (the
    sidebar device grid) can read cached/live status and snapshot freshness
    without one hook per environment. Values are stabilized: shell writes
    replace state objects constantly, but unchanged entries keep identity. */
let previousEnvironmentShellStates: ReadonlyMap<EnvironmentId, EnvironmentShellState> =
  EMPTY_ENVIRONMENT_SHELL_STATES;
export const environmentShellStatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const next = new Map<EnvironmentId, EnvironmentShellState>();
  for (const environmentId of catalog.entries.keys()) {
    next.set(environmentId, get(environmentShell.stateValueAtom(environmentId)));
  }
  if (shellStatesEqual(previousEnvironmentShellStates, next)) {
    return previousEnvironmentShellStates;
  }
  previousEnvironmentShellStates = next;
  return previousEnvironmentShellStates;
}).pipe(Atom.withLabel("web-environment-shell-states"));

/**
 * Every enabled machine has sent its live projects or has settled offline. Prompt links wait for
 * it before they decide a repository is missing: one offline machine must not hold a link
 * forever. A machine that has not started connecting yet is "available", not offline.
 */
export const allReachableShellsLiveAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalogIsComplete(catalog, !isHostedStaticApp())) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) continue;
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (Option.isNone(state)) return false;
    const connection = state.value;
    const settledOffline =
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2);
    if (!settledOffline) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-reachable-shells-live"));
