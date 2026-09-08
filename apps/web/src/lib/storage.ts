export interface DeviceCredentials {
  deviceId: string;
  token: string;
}

const CREDENTIALS_KEY = "touchbar.device-credentials.v1";
const TAB_KEY = "touchbar.selected-tab.v2";
const LEGACY_PROFILE_KEY = "touchbar.selected-profile.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadCredentials(): DeviceCredentials | null {
  if (!canUseStorage()) return null;

  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CREDENTIALS_KEY) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).deviceId === "string" &&
      typeof (value as Record<string, unknown>).token === "string"
    ) {
      const { deviceId, token } = value as DeviceCredentials;
      return deviceId && token ? { deviceId, token } : null;
    }
  } catch {
    // Treat malformed browser storage as an expired pairing.
  }

  return null;
}

export function saveCredentials(credentials: DeviceCredentials): void {
  if (canUseStorage()) {
    window.localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  }
}

export function clearCredentials(): void {
  if (canUseStorage()) {
    window.localStorage.removeItem(CREDENTIALS_KEY);
  }
}

export function loadSelectedTab(): string | null {
  if (!canUseStorage()) return null;
  return window.localStorage.getItem(TAB_KEY) ?? window.localStorage.getItem(LEGACY_PROFILE_KEY);
}

export function saveSelectedTab(tabId: string): void {
  if (canUseStorage()) window.localStorage.setItem(TAB_KEY, tabId);
}
