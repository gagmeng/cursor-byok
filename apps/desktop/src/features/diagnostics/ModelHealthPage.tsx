//! Presents observed model health and individually requested capability tests.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { configuredPluginModels, type ModelCapability } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { modelProviderName } from "../../shared/utils/modelProvider";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ModelSelect } from "../../shared/ui/ModelSelect";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import { diagnosticsStore, useDiagnostics } from "./diagnosticsStore";
import styles from "./Diagnostics.module.scss";

const capabilities: ModelCapability[] = ["streaming", "tools", "vision", "cache"];
export function ModelHealthPage() {
  const { models, plugins } = useAppStore();
  const { models: diagnostics, tests, error } = useDiagnostics();
  const [params, setParams] = useSearchParams();
  const options = [...models.map((model) => ({value: model.model_hash, label: model.display_name, group: modelProviderName(model)})),
    ...configuredPluginModels(plugins).map((model) => ({value: model.id, label: model.displayName, group: model.pluginName, iconSrc: model.icon || undefined}))];
  const selected = params.get("model") ?? options[0]?.value ?? "";
  const [batch, setBatch] = useState(false);
  const health = diagnostics.health.find((item) => item.model_id === selected);
  const active = tests[selected];
  const labels = { streaming: t("流式响应"), tools: t("工具调用往返"), vision: t("图片理解"), cache: t("缓存与上下文续接") };
  const descriptions = { streaming: t("检查多次文本增量与完整结束事件。"), tools: t("检查工具参数，并模拟返回结果后继续生成；不会执行工作区工具。"), vision: t("发送一张生成的纯色图片，验证模型能识别图像内容。"), cache: t("发送两轮稳定上下文，检查续接结果和提供商报告的缓存命中。") };
  useEffect(() => { void diagnosticsStore.refresh(); }, [models, plugins]);
  const testAll = async () => {
    setBatch(true);
    try { for (const capability of capabilities) { const status = await diagnosticsStore.test(selected, capability); if (!status || status === "cancelled") break; } }
    finally { setBatch(false); }
  };
  return <>
    <PageActions>
      <div className={styles.modelSelect}><ModelSelect mode="single" value={selected} options={options} onChange={(model) => setParams({model})} label={t("选择模型")} disabled={!!active || batch} /></div>
      <Button variant="primary" disabled={!selected || !!active || batch} onClick={() => void testAll()}>{batch ? t("测试中…") : t("测试全部能力")}</Button>
    </PageActions>
    <PageContent title={<span className={styles.pageTitle}>{t("模型健康")}</span>} sections={[
      {key:"health",estimatedHeight:220,content:<Card className={styles.panel}>
        <p>{t("健康数据来自最近 7 天的实际调用，能力测试调用不计入健康成功率。取消和进行中的调用单独统计。")}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {!selected ? <p>{t("请先配置一个模型。")}</p> : !health ? <p>{t("该模型尚无实际调用记录。")}</p> : <>
          <div className={styles.metrics}>
            <div><small>{t("成功率")}</small><strong>{health.success_rate === null ? "—" : `${(health.success_rate*100).toFixed(1)}%`}</strong></div>
            <div><small>{t("成功 / 失败")}</small><strong>{health.completed} / {health.failed}</strong></div>
            <div><small>{t("取消 / 进行中")}</small><strong>{health.cancelled} / {health.running}</strong></div>
            <div><small>{t("平均首个有效响应")}</small><strong>{health.average_first_response_ms === null ? "—" : `${Math.round(health.average_first_response_ms)} ms`}</strong></div>
            <div><small>{t("生成速度")}</small><strong>{health.tokens_per_second === null ? "—" : `${health.tokens_per_second.toFixed(1)} token/s`}</strong></div>
          </div>
          <small>{t("最近调用")}：{new Date(health.last_call_at_ms).toLocaleString()}</small>
          {health.last_error && <p className={styles.error}>{t("最近错误")}：{health.last_error}</p>}
        </>}
      </Card>},
      {key:"capability-notice",estimatedHeight:75,content:<Card className={styles.panel}><p>{t("测试会向选定模型发送少量请求，可能消耗额度。全部测试最多发送 6 次请求；每项最长 90 秒。缓存未命中只表示未能确认。")}</p></Card>},
      ...capabilities.map((capability) => {
        const result=diagnostics.capabilities.find((item)=>item.model_id===selected && item.capability===capability);
        const running=active?.capability===capability;
        const state=running ? "running" : result?.status ?? "untested";
        return {key:capability,estimatedHeight:170,content:<Card className={styles.panel}>
          <div className={styles.resultHeader}><strong>{labels[capability]}</strong><span className={styles.status} data-state={state}>{running ? t("测试中…") : !result ? t("未测试") : result.status==="passed" ? t("通过") : result.status==="failed" ? t("失败") : result.status==="cancelled" ? t("已取消") : t("未能确认")}</span><Button variant="secondary" disabled={!selected || (running ? active.cancelling : !!active || batch)} onClick={() => void (running ? diagnosticsStore.cancel(selected) : diagnosticsStore.test(selected,capability))}>{running ? active.cancelling ? t("取消中…") : t("取消测试") : t("运行测试")}</Button></div>
          <small>{descriptions[capability]}</small>
          {result && <><p className={result.status==="failed" ? styles.error : undefined}>{result.detail}</p><small>{new Date(result.tested_at_ms).toLocaleString()} · {result.duration_ms} ms</small></>}
        </Card>};
      }),
    ]} />
  </>;
}
