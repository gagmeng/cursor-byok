-- Idle pruning in older builds left conversation heads pointing at deleted cache rows.
UPDATE conversations SET current_checkpoint_id = NULL, active_run_id = NULL
WHERE current_checkpoint_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM conversation_checkpoints ck
                  WHERE ck.checkpoint_id = conversations.current_checkpoint_id
                    AND ck.conversation_id = conversations.conversation_id);

UPDATE model_configs SET fallback_model_hash = NULL
WHERE fallback_model_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_configs target WHERE target.model_hash = model_configs.fallback_model_hash);

WITH RECURSIVE chain(source, target, depth) AS (
    SELECT model_hash, fallback_model_hash, 1 FROM model_configs WHERE fallback_model_hash IS NOT NULL
    UNION ALL
    SELECT chain.source, next.fallback_model_hash, chain.depth + 1
    FROM chain JOIN model_configs next ON next.model_hash = chain.target
    WHERE next.fallback_model_hash IS NOT NULL AND chain.depth < 5
)
UPDATE model_configs SET fallback_model_hash = NULL
WHERE model_hash IN (SELECT source FROM chain WHERE source = target OR depth > 4);

UPDATE service_settings SET value_json = json_set(value_json, '$.model_id', '')
WHERE setting_key = 'commit_settings'
  AND COALESCE(json_extract(value_json, '$.model_id'), '') != ''
  AND json_extract(value_json, '$.model_id') NOT LIKE 'plugin:%'
  AND NOT EXISTS (SELECT 1 FROM model_configs WHERE model_hash = json_extract(value_json, '$.model_id'));

UPDATE service_settings SET value_json = '""'
WHERE setting_key = 'auto_review_model'
  AND COALESCE(json_extract(value_json, '$'), '') != ''
  AND json_extract(value_json, '$') NOT LIKE 'plugin:%'
  AND NOT EXISTS (SELECT 1 FROM model_configs WHERE model_hash = json_extract(value_json, '$'));
