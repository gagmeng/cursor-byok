//! Validates portable configuration before exposing it to the import preview.
import type { MigrationFile } from "../../shared/api";

export function parseMigrationFile(text: string): MigrationFile {
  const file: unknown = JSON.parse(text);
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === "string");
  if (!object(file) || file.format !== "cursor-byok-migration" || file.version !== 3
    || typeof file.app_version !== "string" || !Number.isFinite(file.exported_at_ms)
    || !Array.isArray(file.models) || !Array.isArray(file.plugin_resources) || !Array.isArray(file.model_system_prompts)
    || !file.models.every((model) => object(model) && strings(model, ["model_hash", "display_name", "base_url", "api_key", "tooltip_data", "model_id"])
      && (model.type === "openai" || model.type === "anthropic") && !!model.model_hash)
    || !file.plugin_resources.every((group) => object(group) && strings(group, ["plugin_id", "resource_type"]) && Array.isArray(group.accounts))
    || (file.plugin_models !== undefined && (!Array.isArray(file.plugin_models) || !file.plugin_models.every((group) => object(group) && strings(group, ["plugin_id", "provider_id"]) && Array.isArray(group.models))))
    || !file.model_system_prompts.every((prompt) => object(prompt) && strings(prompt, ["model_id", "content"]) && typeof prompt.enabled === "boolean" && ["before", "after", "replace"].includes(String(prompt.position)))) {
    throw new Error("Migration file requires format cursor-byok-migration, version 3, and complete model, credential, and prompt lists");
  }
  return file as unknown as MigrationFile;
}
