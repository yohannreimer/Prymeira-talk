interface RuntimeConfig {
  VITE_API_URL?: string;
  VITE_LOCAL_AUTH_BYPASS?: string;
  VITE_CLERK_PUBLISHABLE_KEY?: string;
}

declare global {
  interface Window {
    __PRYMEIRA_TALK_CONFIG__?: RuntimeConfig;
  }
}

function readRuntimeConfig(): RuntimeConfig {
  if (typeof window === "undefined") {
    return {};
  }

  return window.__PRYMEIRA_TALK_CONFIG__ ?? {};
}

export function readConfigValue(key: keyof RuntimeConfig) {
  return readRuntimeConfig()[key] ?? import.meta.env[key];
}
