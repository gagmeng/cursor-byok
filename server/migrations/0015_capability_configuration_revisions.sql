CREATE TABLE model_capability_revisions (
    model_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
