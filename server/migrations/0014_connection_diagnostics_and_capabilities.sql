CREATE TABLE connection_diagnostics (
    diagnostic_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('local', 'ssh')),
    marker TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL,
    request_id TEXT,
    conversation_id TEXT,
    request_seen_at_ms INTEGER,
    stream_seen_at_ms INTEGER
);

CREATE TABLE model_capability_tests (
    model_id TEXT NOT NULL,
    capability TEXT NOT NULL CHECK(capability IN ('streaming', 'tools', 'vision', 'cache')),
    status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'inconclusive', 'cancelled')),
    tested_at_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
    detail TEXT NOT NULL,
    PRIMARY KEY(model_id, capability)
);
