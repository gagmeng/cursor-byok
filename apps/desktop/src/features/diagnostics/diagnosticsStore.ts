//! Owns diagnostic snapshots, request ordering, and capability test lifecycles.
import { useSyncExternalStore } from "react";
import { api, type ConnectionDiagnostics, type ModelCapability, type ModelDiagnostics } from "../../shared/api";

type Snapshot = {
  connection: ConnectionDiagnostics | null;
  models: ModelDiagnostics;
  busy: boolean;
  error: string | null;
  tests: Record<string, { id: string; capability: ModelCapability; cancelling: boolean }>;
};
let snapshot: Snapshot = { connection: null, models: { health: [], capabilities: [] }, busy: false, error: null, tests: {} };
const listeners = new Set<() => void>();
let generation = 0;
function update(patch: Partial<Snapshot>) { snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => listener()); }
const text = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export const diagnosticsStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot: () => snapshot,
  async refresh(quiet = false) {
    const current = ++generation;
    if (!quiet) update({ busy: true, error: null });
    const errors: string[] = [];
    await Promise.all([
      api.connectionDiagnostics().then((connection) => { if (current === generation) update({ connection }); }).catch((cause) => errors.push(text(cause))),
      api.modelDiagnostics().then((models) => { if (current === generation) update({ models }); }).catch((cause) => errors.push(text(cause))),
    ]);
    if (current === generation) update({ busy: false, error: errors.length ? errors.join("; ") : null });
  },
  async start(scope: "local" | "ssh") {
    update({ busy: true, error: null });
    try { await api.startConnectionDiagnostic(scope); await diagnosticsStore.refresh(); }
    catch (cause) { update({ busy: false, error: text(cause) }); }
  },
  async test(model: string, capability: ModelCapability) {
    if (snapshot.tests[model]) return;
    const id = crypto.randomUUID();
    update({ tests: { ...snapshot.tests, [model]: { id, capability, cancelling: false } }, error: null });
    try {
      const result = await api.testCapability(model, id, capability);
      await diagnosticsStore.refresh(true);
      return result.status;
    } catch (cause) { update({ error: text(cause) }); }
    finally {
      const tests = { ...snapshot.tests };
      delete tests[model];
      update({ tests });
    }
  },
  async cancel(model: string) {
    const test = snapshot.tests[model];
    if (!test || test.cancelling) return;
    update({ tests: { ...snapshot.tests, [model]: { ...test, cancelling: true } } });
    try { await api.cancelModelTest(model, test.id); }
    catch (cause) { update({ error: text(cause), tests: { ...snapshot.tests, [model]: { ...test, cancelling: false } } }); }
  },
};

export function useDiagnostics() { return useSyncExternalStore(diagnosticsStore.subscribe, diagnosticsStore.getSnapshot); }
