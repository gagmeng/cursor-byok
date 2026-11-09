-- A model's system prompt can replace the Cursor original instead of being
-- inserted before or after it. SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt with the wider allowed set; rows keep their identity,
-- content, and timestamp.
CREATE TABLE model_system_prompts_new (
    model_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(model_id)) > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 32768),
    position TEXT NOT NULL CHECK(position IN ('before', 'after', 'replace')),
    updated_at_ms INTEGER NOT NULL,
    CHECK(enabled = 0 OR length(content) > 0)
);

INSERT INTO model_system_prompts_new(model_id, enabled, content, position, updated_at_ms)
SELECT model_id, enabled, content, position, updated_at_ms FROM model_system_prompts;

DROP TABLE model_system_prompts;

ALTER TABLE model_system_prompts_new RENAME TO model_system_prompts;
