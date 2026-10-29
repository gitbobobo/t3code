import { useEffect } from "react";

import { resolveSidebarDeviceScope } from "../components/SidebarDeviceScope.logic";
import { useClientSettings } from "./useSettings";
import { useEnvironments } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";

/** The persisted key is intentionally separate from the effective scope:
 * one-environment, legacy, and not-yet-ready catalogs must all behave as
 * "all devices" without losing a valid preference during a transient load. */
export function useSidebarDeviceScope() {
  const requestedEnvironmentId = useUiStateStore((state) => state.sidebarDeviceScopeKey);
  const setSidebarDeviceScopeKey = useUiStateStore((state) => state.setSidebarDeviceScopeKey);
  const { environments, isReady } = useEnvironments();
  const legacySidebarEnabled = useClientSettings((settings) => settings.legacySidebarEnabled);
  const environmentIds = environments.map((environment) => String(environment.environmentId));
  const scopeEnvironmentId = resolveSidebarDeviceScope({
    enabled: !legacySidebarEnabled,
    catalogReady: isReady,
    environmentIds,
    requestedEnvironmentId,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears a persisted device preference when the environment catalog permanently removes it
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
