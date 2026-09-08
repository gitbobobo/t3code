import { useEffect, useMemo } from "react";

import { resolveSidebarDeviceScope } from "../components/SidebarDeviceScope.logic";
import { useLegacySidebarEnabled } from "./useSettings";
import { useEnvironments } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";

/** The persisted key is intentionally separate from the effective scope:
 * one-environment, legacy, and not-yet-ready catalogs must all behave as
 * "all devices" without losing a valid preference during a transient load. */
export function useSidebarDeviceScope() {
  const requestedEnvironmentId = useUiStateStore((state) => state.sidebarDeviceScopeKey);
  const setSidebarDeviceScopeKey = useUiStateStore((state) => state.setSidebarDeviceScopeKey);
  const { environments, isReady } = useEnvironments();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const environmentIds = useMemo(
    () => environments.map((environment) => String(environment.environmentId)),
    [environments],
  );
  const scopeEnvironmentId = resolveSidebarDeviceScope({
    enabled: !legacySidebarEnabled,
    catalogReady: isReady,
    environmentIds,
    requestedEnvironmentId,
  });

  useEffect(() => {
    if (
      isReady &&
      requestedEnvironmentId !== null &&
      !environmentIds.includes(requestedEnvironmentId)
    ) {
      setSidebarDeviceScopeKey(null);
    }
  }, [environmentIds, isReady, requestedEnvironmentId, setSidebarDeviceScopeKey]);

  return {
    requestedEnvironmentId,
    scopeEnvironmentId,
    environments,
    isReady,
  };
}
