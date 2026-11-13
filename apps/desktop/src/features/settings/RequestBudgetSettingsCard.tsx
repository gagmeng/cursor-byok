import { useEffect, useState } from "react";
import { api, type RequestBudgetSettings } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./SettingsPage.module.scss";

export function RequestBudgetSettingsCard() {
  const message = useMessage();
  const [settings, setSettings] = useState<RequestBudgetSettings | null>(null);
  const [requestTimeout, setRequestTimeout] = useState("3600");
  const [idleTimeout, setIdleTimeout] = useState("1800");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    void api.requestBudget().then((value) => {
      if (disposed) return;
      setSettings(value);
      setRequestTimeout(String(value.request_timeout_seconds));
      setIdleTimeout(String(value.stream_idle_timeout_seconds));
    }).catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
    return () => { disposed = true; };
  }, [message]);

  const save = async () => {
    const next = {
      request_timeout_seconds: Number(requestTimeout),
      stream_idle_timeout_seconds: Number(idleTimeout),
    };
    if (!Number.isInteger(next.request_timeout_seconds) || !Number.isInteger(next.stream_idle_timeout_seconds)) {
      message(t("超时必须是整数秒"));
      return;
    }
    setSaving(true);
    try {
      const saved = await api.setRequestBudget(next);
      setSettings(saved);
      setEditing(false);
      message(t("请求超时已保存，下一次模型调用生效"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <TitledCard title={t("请求超时")}>
    <div className={styles.settingRow}>
      <div>
        <strong>{t("总超时与流空闲")}</strong>
        <small>{t("总超时是单次模型请求的上限。流空闲是等待下一个事件的时间，思考模型可以单独加大。429 的 Retry-After 不会超过剩余总超时。")}</small>
      </div>
      {editing ? <div className={styles.languageControl}>
        <FormField label={t("总超时（秒）")}><TextInput value={requestTimeout} inputMode="numeric" onChange={(event) => setRequestTimeout(event.target.value)} /></FormField>
        <FormField label={t("流空闲（秒）")}><TextInput value={idleTimeout} inputMode="numeric" onChange={(event) => setIdleTimeout(event.target.value)} /></FormField>
        <Button size="small" disabled={saving} onClick={() => void save()}>{saving ? t("保存中…") : t("保存")}</Button>
        <Button size="small" disabled={saving} onClick={() => {
          if (settings) {
            setRequestTimeout(String(settings.request_timeout_seconds));
            setIdleTimeout(String(settings.stream_idle_timeout_seconds));
          }
          setEditing(false);
        }}>{t("取消")}</Button>
      </div> : <div className={styles.languageControl}>
        <span>{t("{request} 秒 / 空闲 {idle} 秒", { request: settings?.request_timeout_seconds ?? "…", idle: settings?.stream_idle_timeout_seconds ?? "…" })}</span>
        <Button size="small" onClick={() => setEditing(true)}>{t("编辑")}</Button>
      </div>}
    </div>
  </TitledCard>;
}
