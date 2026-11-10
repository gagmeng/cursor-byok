import { useSyncExternalStore } from "react";
import { api, type CursorHarnessStatus, type LlmCall, type Model, type ModelInput, type Overview, type PluginDescriptor, type PluginRuntimeStatus, type PortSettings, type TokenPricingSettings } from "../api";
import { applyTheme, isThemeId, type ThemeId } from "../theme/theme";

export const DEFAULT_TOKEN_PRICING: TokenPricingSettings = {
  input_per_million: 5.0,
  output_per_million: 25.0,
  cache_read_per_million: 0.5,
  cache_write_per_million: 6.25,
};

export type AppSnapshot = {
  models: Model[];
  calls: LlmCall[];
  overview: Overview;
  detailed: boolean;
  ports: PortSettings;
  pricing: TokenPricingSettings;
  busy: boolean;
  error: string | null;
  theme: ThemeId;
  cursorHarness: CursorHarnessStatus | null;
  cursorBusy: boolean;
  pluginRuntime: PluginRuntimeStatus | null;
  plugins: PluginDescriptor[];
};

const savedTheme = (): ThemeId => {
  const saved = localStorage.getItem("cursor-byok.theme");
  return isThemeId(saved) ? saved : "default-dark";
};

let snapshot: AppSnapshot = {
  models: [],
  calls: [],
  overview: {
    metrics: {
      llm_calls: 0,
      successful_calls: 0,
      failed_calls: 0,
      token_usage: 0,
      prompt_tokens: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
    },
    token_usage_granularity: "day",
    token_usage_series: [],
  },
  detailed: false,
  ports: { proxy_port: 0, service_port: 0 },
  pricing: DEFAULT_TOKEN_PRICING,
  busy: false,
  error: null,
  theme: savedTheme(),
  cursorHarness: null,
  cursorBusy: false,
  pluginRuntime: null,
  plugins: [],
};

const listeners = new Set<() => void>();
let refreshGeneration = 0;
let callsGeneration = 0;

function update(patch: Partial<AppSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

async function perform(task: () => Promise<void>) {
  update({ error: null });
  try {
    await task();
  } catch (cause) {
    update({ error: cause instanceof Error ? cause.message : String(cause) });
  }
}

export const appStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,

  async refresh() {
    update({ busy: true, error: null });
    const generation = ++refreshGeneration;
    const callsVersion = ++callsGeneration;
    const errors: string[] = [];
    const load = async <T,>(task: Promise<T>, patch: (value: T) => Partial<AppSnapshot>) => {
      try {
        const value = await task;
        if (generation === refreshGeneration) update(patch(value));
      } catch (cause) {
        errors.push(cause instanceof Error ? cause.message : String(cause));
      }
    };
    await Promise.all([
      load(api.models(), (models) => ({ models })),
      load(api.calls(), (calls) => callsVersion === callsGeneration ? ({ calls }) : ({})),
      load(api.overview(), (overview) => ({ overview })),
      load(api.observability(), ({ detailed }) => ({ detailed })),
      load(api.ports(), (ports) => ({ ports })),
      load(api.pricingSettings(), (pricing) => ({ pricing })),
      load(api.cursorHarness(), (cursorHarness) => ({ cursorHarness })),
      load(api.pluginRuntime(), (pluginRuntime) => ({ pluginRuntime })),
      load(api.plugins(), (plugins) => ({ plugins })),
    ]);
    if (generation === refreshGeneration) update({ busy: false, error: errors.length ? errors.join("; ") : null });
  },

  async deleteModel(modelHash: string) {
    await perform(async () => {
      await api.deleteModel(modelHash);
      await appStore.refresh();
    });
  },

  async initializeCursorCa() {
    update({ cursorBusy: true, error: null });
    try {
      const status = await api.initializeCursorCa();
      update({ cursorHarness: status });
      return status;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async initializePluginRuntime() {
    update({ error: null });
    try {
      const pluginRuntime = await api.initializePluginRuntime();
      update({ pluginRuntime });
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshPluginRuntime() {
    try {
      const wasReady = snapshot.pluginRuntime?.state === "ready";
      const pluginRuntime = await api.pluginRuntime();
      update({ pluginRuntime });
      if (!wasReady && pluginRuntime.state === "ready") {
        const plugins = await api.plugins();
        update({ plugins });
      }
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async cancelPluginRuntimeInitialization() {
    try {
      const pluginRuntime = await api.cancelPluginRuntimeInitialization();
      update({ pluginRuntime });
      return pluginRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshPlugins() {
    try {
      update({ plugins: await api.plugins() });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },
  async removePluginConfiguration(pluginId: string) {
    await perform(async () => {
      await api.removePluginConfiguration(pluginId);
      update({ plugins: await api.plugins() });
    });
  },
  async setCursorEnabled(enabled: boolean) {
    update({ cursorBusy: true, error: null });
    try { update({ cursorHarness: await api.setCursorEnabled(enabled) }); }
    catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { update({ cursorBusy: false }); }
  },
  async createModels(models: ModelInput[]) {
    update({ cursorBusy: true, error: null });
    try {
      const created = await api.createModels(models);
      await appStore.refresh();
      return created;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async importV0049Models() {
    update({ cursorBusy: true, error: null });
    try {
      const result = await api.importV0049Models();
      await appStore.refresh();
      return result;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async importMagpieModels(modelIds: string[], address?: string) {
    update({ cursorBusy: true, error: null });
    try {
      const result = await api.importMagpieModels(modelIds, address);
      await appStore.refresh();
      return result;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async updateCursorModel(hash: string, model: ModelInput) {
    update({ cursorBusy: true, error: null });
    try {
      const updated = await api.updateModel(hash, model);
      await appStore.refresh();
      return updated;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },

  async refreshCalls() {
    const generation = ++callsGeneration;
    try {
      const calls = await api.calls();
      if (generation === callsGeneration) update({ calls });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },

  async openCallDetails(callId: string) {
    await perform(() => api.openCallDetails(callId));
  },
  async updateDetailed(detailed: boolean) {
    await perform(async () => update(await api.setObservability(detailed)));
  },
  async updatePorts(ports: PortSettings) {
    try {
      update({ error: null });
      update({ ports: await api.setPorts(ports) });
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  },
  async updatePricingSettings(pricing: TokenPricingSettings) {
    try {
      update({ error: null });
      update({ pricing: await api.setPricingSettings(pricing) });
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  },
  selectTheme(theme: ThemeId) {
    localStorage.setItem("cursor-byok.theme", theme);
    applyTheme(theme);
    update({ theme });
  },
};

// "system" 档位跟随操作系统深浅色切换;其余档位不受影响。
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => {
    if (snapshot.theme === "system") applyTheme("system");
  });

export function useAppStore() {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot);
}
