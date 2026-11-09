//! 展示并编辑单个 Cursor 模型的系统提示词草稿。
import { useId } from "react";
import type { ModelSystemPromptSettings } from "../../shared/api";
import { FormField } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import { Switch } from "../../shared/ui/Switch";
import { MODEL_SYSTEM_PROMPT_MAX_BYTES, modelSystemPromptStatus } from "./cursorSystemPrompt";
import styles from "./CursorSystemPromptSettings.module.scss";

type CursorSystemPromptSettingsProps = {
  modelName: string;
  settings: ModelSystemPromptSettings;
  disabled: boolean;
  onChange: (settings: ModelSystemPromptSettings) => void;
};

export function CursorSystemPromptSettings({ modelName, settings, disabled, onChange }: CursorSystemPromptSettingsProps) {
  const descriptionId = useId();
  const countId = useId();
  const errorId = useId();
  const status = modelSystemPromptStatus(settings);
  const error = status.error === "too-large"
    ? t("系统提示词不能超过 {limit} 个 UTF-8 字节。", { limit: MODEL_SYSTEM_PROMPT_MAX_BYTES })
    : status.error === "empty" ? t("启用系统提示词时，内容不能全为空白。") : null;

  return <div className={styles.editor}>
    <strong className={styles.modelName}>{modelName}</strong>
    <p id={descriptionId} className={styles.description}>{t("仅用于 Cursor 对话；现有会话使用已采用的配置，新会话生效。")}</p>
    <div className={styles.switchRow}>
      <div className={styles.switchDetails}>
        <span>{t("启用系统提示词")}</span>
        <span className={styles.hint}>{t("关闭后保留提示词内容。")}</span>
      </div>
      <Switch
        checked={settings.enabled}
        disabled={disabled}
        label={t("启用系统提示词")}
        onChange={(enabled) => onChange({ ...settings, enabled })}
      />
    </div>
    <FormField label={t("组合方式")} hint={t("前置/后置把自定义提示词接到 Cursor 原有提示词旁；替换则完全用自定义提示词取代原有提示词。")}>
      <Select
        value={settings.position}
        disabled={disabled}
        ariaLabel={t("系统提示词组合方式")}
        options={[
          { value: "before", label: t("前置") },
          { value: "after", label: t("后置") },
          { value: "replace", label: t("替换") },
        ]}
        onChange={(position) => onChange({ ...settings, position: position as ModelSystemPromptSettings["position"] })}
      />
    </FormField>
    <FormField label={t("系统提示词内容")}>
      <textarea
        className={styles.promptEditor}
        rows={16}
        value={settings.content}
        disabled={disabled}
        spellCheck={false}
        aria-label={t("系统提示词内容")}
        aria-describedby={[descriptionId, countId, error && errorId].filter(Boolean).join(" ")}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange({ ...settings, content: event.target.value })}
      />
    </FormField>
    <div id={countId} className={styles.byteCount} data-invalid={status.error === "too-large" || undefined}>
      {t("{bytes} / {limit} 字节（UTF-8）", { bytes: status.byteLength, limit: MODEL_SYSTEM_PROMPT_MAX_BYTES })}
    </div>
    {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
  </div>;
}
