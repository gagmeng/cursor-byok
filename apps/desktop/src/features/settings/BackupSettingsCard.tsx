import { useEffect, useState } from "react";
import { api, type BackupIndex, type BackupPreview } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { appStore } from "../../shared/store/appStore";
import styles from "./BackupSettingsCard.module.scss";

export function BackupSettingsCard() {
  const message = useMessage();
  const [index, setIndex] = useState<BackupIndex | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api.backups().then(setIndex).catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(load, [message]);

  const openPreview = async (name: string) => {
    setBusy(true);
    try {
      setPreview(await api.previewBackup(name));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (mode: "skip" | "overwrite") => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.restoreBackup(preview.name, mode);
      await appStore.refresh();
      setPreview(null);
      load();
      message(t("已从备份恢复。恢复前的快照是 {snapshot}。新增模型 {added} 个，覆盖模型 {updated} 个。", {
        snapshot: result.snapshot,
        added: result.result.models_added,
        updated: result.result.models_updated ?? 0,
      }));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <TitledCard title={t("配置备份")}>
    <div className={styles.content}>
      <div className={styles.intro}>
        <strong>{t("最近备份")}</strong>
        <small>{t("启动时和之后每天各写一份，保留最近 7 份。恢复前会先写下当前配置。跳过保留已有标识，覆盖会改成备份里的内容。")}</small>
        {index?.last_error && <small>{t("最近一次备份失败：{error}", { error: index.last_error })}</small>}
      </div>
      <div className={styles.list}>
        {(index?.backups ?? []).length === 0 && <span>{t("还没有备份")}</span>}
        {(index?.backups ?? []).map((backup) => <div className={styles.row} key={backup.name}>
          <span className={styles.time}>{backup.readable && backup.exported_at_ms ? new Date(backup.exported_at_ms).toLocaleString() : t("无法读取")}</span>
          <Button disabled={busy || !backup.readable} onClick={() => void openPreview(backup.name)}>{t("查看差异")}</Button>
        </div>)}
      </div>
      {preview && <div className={styles.preview}>
        <strong>{t("相对当前配置")}</strong>
        <small>{t("新增模型：{added}。变更模型：{changed}。仅本地有：{local}。未变：{same}。插件模型新增 {pluginAdded}，变更 {pluginChanged}。凭证新增 {accountsAdded}，变更 {accountsChanged}。", {
          added: preview.models_added.join("、") || t("无"),
          changed: preview.models_changed.join("、") || t("无"),
          local: preview.models_only_local.join("、") || t("无"),
          same: preview.models_unchanged,
          pluginAdded: preview.plugin_models_added.length,
          pluginChanged: preview.plugin_models_changed.length,
          accountsAdded: preview.accounts_added,
          accountsChanged: preview.accounts_changed,
        })}</small>
        <div className={styles.actions}>
          <Button disabled={busy} onClick={() => void restore("skip")}>{t("跳过已有")}</Button>
          <Button disabled={busy} onClick={() => void restore("overwrite")}>{t("覆盖已有")}</Button>
          <Button disabled={busy} onClick={() => setPreview(null)}>{t("取消")}</Button>
        </div>
      </div>}
    </div>
  </TitledCard>;
}
