import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CallTable } from "./CallTable";
import { PageContent } from "../../shell/layout/PageContent";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/FormControls";
import styles from "./CallsPage.module.scss";

const CALL_REFRESH_INTERVAL_MS = 2_000;

export function CallsPage() {
  const { calls, callsNext, callFilter } = useAppStore();
  const navigate = useNavigate();
  const [model, setModel] = useState(callFilter.model);
  const [conversationId, setConversationId] = useState(callFilter.conversationId);
  const appended = useRef(false);

  useEffect(() => {
    appended.current = false;
    let disposed = false;
    const refreshCalls = () => {
      if (!disposed && !appended.current && document.visibilityState === "visible") {
        void appStore.refreshCalls(false);
      }
    };

    refreshCalls();
    const interval = window.setInterval(refreshCalls, CALL_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshCalls);
    document.addEventListener("visibilitychange", refreshCalls);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshCalls);
      document.removeEventListener("visibilitychange", refreshCalls);
    };
  }, [callFilter.status, callFilter.model, callFilter.conversationId]);

  const applyTextFilter = () => {
    void appStore.setCallFilter({ ...callFilter, model: model.trim(), conversationId: conversationId.trim() });
  };

  const content = <div className={styles.page}><CallTable calls={calls} onDetails={(call) => navigate(`/calls/${encodeURIComponent(call.call_id)}`)} /></div>;
  return <>
    <PageActions position="left">
      <Select
        ariaLabel={t("调用状态")}
        value={callFilter.status}
        options={[
          { value: "", label: t("全部状态") },
          { value: "running", label: t("进行中") },
          { value: "completed", label: t("已完成") },
          { value: "failed", label: t("失败") },
          { value: "cancelled", label: t("已取消") },
        ]}
        onChange={(status) => void appStore.setCallFilter({ ...callFilter, status })}
      />
      <TextInput
        aria-label={t("模型")}
        value={model}
        placeholder={t("模型")}
        onChange={(event) => setModel(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") applyTextFilter(); }}
        onBlur={applyTextFilter}
      />
      <TextInput
        aria-label={t("会话 ID")}
        value={conversationId}
        placeholder={t("会话 ID")}
        onChange={(event) => setConversationId(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") applyTextFilter(); }}
        onBlur={applyTextFilter}
      />
    </PageActions>
    {callsNext && <PageActions><Button size="small" onClick={() => { appended.current = true; void appStore.refreshCalls(true); }}>{t("加载更早的记录")}</Button></PageActions>}
    <PageContent fixed title={t("调用")} contentClassName={styles.pageContent} sections={[{ key: "calls", estimatedHeight: 720, content }]} />
  </>;
}
