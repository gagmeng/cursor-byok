-- Failover target for a model: when its provider call fails before any
-- output, the run engine retries the same turn on this model.
ALTER TABLE model_configs ADD COLUMN fallback_model_hash TEXT;
