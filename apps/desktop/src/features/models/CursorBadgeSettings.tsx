import type { Model, ModelBadgeColor, ModelBadgeSettings } from "../../shared/api";
import { FormField } from "../../shared/ui/FormControls";
import styles from "./CursorBadgeSettings.module.scss";

const COLOR_VALUES: ModelBadgeColor[] = ["accent", "neutral", "success", "warn", "danger"];

export const DEFAULT_MODEL_BADGE_SETTINGS: ModelBadgeSettings = { color: "neutral" };

function colorLabel(color: ModelBadgeColor): string {
  switch (color) {
    case "accent": return t("强调");
    case "neutral": return t("中性");
    case "success": return t("成功");
    case "warn": return t("警告");
    case "danger": return t("危险");
  }
}

/** Mirrors the server: the badge carries the group name, then the API host. */
function badgeLabel(model: Model): string | null {
  return model.group_name?.trim() || host(model.base_url);
}

function host(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function CursorBadgeSettings({ settings, sample, onChange }: { settings: ModelBadgeSettings; sample: Model | null; onChange: (settings: ModelBadgeSettings) => void }) {
  const label = sample ? badgeLabel(sample) : null;
  return <div className={styles.body}>
    <div className={styles.preview}>
      <span className={styles.previewLabel}>{t("预览")}</span>
      <span className={styles.previewBadges}>
        {sample && <span className={styles.previewName}>{sample.display_name}</span>}
        {label
          ? <span className={styles.badge} data-color={settings.color}>{label}</span>
          : <span className={styles.previewEmpty}>{t("该模型没有分组名称或可用域名")}</span>}
      </span>
    </div>
    <FormField label={t("徽章颜色")}>
      <div className={styles.colors} role="radiogroup" aria-label={t("徽章颜色")}>
        {COLOR_VALUES.map((color) => <button
          key={color}
          type="button"
          role="radio"
          aria-checked={settings.color === color}
          aria-label={colorLabel(color)}
          title={colorLabel(color)}
          className={styles.swatch}
          data-color={color}
          onClick={() => onChange({ color })}
        />)}
      </div>
    </FormField>
    <span className={styles.hint}>{t("徽章固定显示分组名称，没有分组时显示服务器域名。Cursor 只提供 5 个预设颜色，没有自由取色；徽章文案会被强制转为大写。")}</span>
  </div>;
}
