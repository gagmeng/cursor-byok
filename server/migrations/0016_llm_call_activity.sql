-- Latest retry or failover note for a call. Null until the engine records one.
ALTER TABLE llm_calls ADD COLUMN activity TEXT;
