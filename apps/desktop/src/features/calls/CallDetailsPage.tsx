import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type CallDetail } from "../../shared/api";
import { CallDetails } from "./CallDetails";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./CallDetailsPage.module.scss";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";

export function CallDetailsPage() {
  const { callId = "" } = useParams();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setDetail(null);
    setError(null);
    const load = () => {
      void api.call(callId).then((value) => {
        if (cancelled) return;
        setDetail(value);
        setError(null);
        if (value.call.status === "running") timer = window.setTimeout(load, 2_000);
      }).catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [callId]);

  const content = error
    ? <TitledCard title={t("无法加载调用详情")}><div style={{ padding: 16 }}>{error}</div></TitledCard>
    : detail
      ? <CallDetails detail={detail} />
      : <TitledCard title={t("调用详情")}><div style={{ padding: 16 }}>{t("正在加载调用详情…")}</div></TitledCard>;

  return <main className={styles.root}>
    <ScrollableContent className={styles.scroller} contentClassName={styles.content}>
      <p className={styles.back}><Link to="/calls">{t("返回调用列表")}</Link></p>
      <h1>{detail?.call.display_name ?? t("调用详情")}</h1>
      {content}
    </ScrollableContent>
  </main>;
}
