-- Model identifiers include local model hashes and plugin model ids; plugin
-- models do not have a row in model_configs, so no model foreign key applies.
CREATE TABLE model_system_prompts (
    model_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(model_id)) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 32768),
    position TEXT NOT NULL CHECK(position IN ('before', 'after')),
    updated_at_ms INTEGER NOT NULL,
    CHECK(enabled = 0 OR length(content) > 0)
);

-- These snapshots outlive live model settings and wire-blob cache pruning.
-- Each mode's final instructions are recorded once, while the model's adopted
-- settings stay fixed across modes and survive process restart.
CREATE TABLE conversation_system_prompts (
    conversation_id TEXT NOT NULL,
    model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
    settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
    instructions_json TEXT NOT NULL CHECK(json_valid(instructions_json) AND json_type(instructions_json) = 'object'),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, model_id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
