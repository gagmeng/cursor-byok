//! Verifies migration input before previewing or submitting it.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMigrationFile } from "./migrationFile.ts";

test("damaged_or_unsupported_migration_files_are_rejected_before_preview", () => {
  for (const value of [null, {}, {format: "cursor-byok-migration"}, {format: "cursor-byok-migration", version: 99, models: []}]) {
    assert.throws(() => parseMigrationFile(JSON.stringify(value)));
  }
});
test("a_complete_empty_bundle_can_be_previewed_without_throwing", () => {
  const file = {format: "cursor-byok-migration", version: 3, app_version: "test", exported_at_ms: 0, models: [], plugin_resources: [], model_system_prompts: []};
  assert.deepEqual(parseMigrationFile(JSON.stringify(file)), file);
});
