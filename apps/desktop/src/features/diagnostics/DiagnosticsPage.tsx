//! Presents first-use setup and separate local and SSH connection evidence.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import { diagnosticsStore, useDiagnostics } from "./diagnosticsStore";
import { connectionSteps, diagnosticInstruction } from "./connectionSteps";
import { RemoteSshHelp } from "../models/RemoteSshHelp";
import styles from "./Diagnostics.module.scss";

export function DiagnosticsPage() {
  const { connection, error, busy } = useDiagnostics();
  const { cursorBusy } = useAppStore();
  const [sshHelp, setSshHelp] = useState(false);
  const message = useMessage();
  useEffect(() => {
    void diagnosticsStore.refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void diagnosticsStore.refresh(true); }, 3000);
    return () => window.clearInterval(timer);
  }, []);
  const ca = connection?.harness.ca === "ready";
  const models = (connection?.configured_models ?? 0) > 0;
  const proxy = connection?.harness.integration === "enabled";
  const initialize = async () => {
    const status = await appStore.initializeCursorCa();
    if (status?.ca === "untrusted" && status.ca_install_command) {
      await api.copyCursorText(status.ca_install_command).catch((cause) => message(String(cause)));
      message(t("请在系统终端执行 CA 安装命令，完成后刷新诊断"), { duration: 8000 });
    }
    await diagnosticsStore.refresh();
  };
  const stepLabels = { request: t("Cursor 请求已到达"), stream: t("Cursor 已订阅响应"), upstream: t("模型已返回有效响应"), tool: t("工具执行结果已返回") };
  const complete = connection?.sessions.some((session) => connectionSteps(session).every((step) => step.state === "passed"));
  return <>
    <PageActions>
      <Button disabled={busy || !ca || !models || !proxy} onClick={() => void diagnosticsStore.start("local")}>{t("验证本地连接")}</Button>
      <Button variant="secondary" disabled={busy || !ca || !models || !proxy} onClick={() => void diagnosticsStore.start("ssh")}>{t("验证 SSH 连接")}</Button>
    </PageActions>
    <PageContent title={<span className={styles.pageTitle}>{t("连接诊断")}</span>} sections={[
      { key: "setup", estimatedHeight: 310, content: <Card className={styles.panel}>
        <p>{t("依次完成配置，再从对应的 Cursor 窗口运行诊断指令。每个环节单独验证。")}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {connection?.harness.startup_error && <p role="alert" className={styles.error}>{connection.harness.startup_error}</p>}
        <ol className={styles.steps}>
          <li><span data-state={ca ? "passed" : "waiting"}>{ca ? t("已就绪") : t("待完成")}</span><div><strong>{t("初始化并信任本地 CA")}</strong><small>{t("CA 就绪后，Cursor 的 HTTPS 请求才能进入本地服务。")}</small></div>{!ca && <Button disabled={cursorBusy} onClick={() => void initialize()}>{t("初始化 CA")}</Button>}</li>
          <li><span data-state={models ? "passed" : "waiting"}>{models ? t("已就绪") : t("待完成")}</span><div><strong>{t("配置至少一个可用模型")}</strong><small>{t("可使用内置模型配置或插件模型，再单独测试模型能力。")}</small></div><Link to="/harness/cursor">{t("模型配置")}</Link></li>
          <li><span data-state={proxy ? "passed" : "waiting"}>{proxy ? t("已就绪") : t("待完成")}</span><div><strong>{t("开启本地接管")}</strong><small>{t("设置生效后请自行重启 Cursor，以加载新的代理配置。")}</small></div>{!proxy && <Button disabled={!ca || cursorBusy} onClick={() => void appStore.setCursorEnabled(true).then(() => diagnosticsStore.refresh())}>{t("开启接管")}</Button>}</li>
          <li><span data-state={complete ? "passed" : "waiting"}>{complete ? t("已验证") : t("未验证")}</span><div><strong>{t("验证请求、响应和工具往返")}</strong><small>{t("在上方选择本地或 SSH，复制生成的指令到相应 Cursor 窗口的新对话中发送。")}</small></div><button className={styles.textButton} onClick={() => setSshHelp(true)}>{t("SSH 配置帮助")}</button></li>
        </ol>
        {!complete && <Link to="/">{t("稍后完成，进入概览")}</Link>}
      </Card> },
      ...(["local", "ssh"] as const).map((scope) => {
        const session = connection?.sessions.find((item) => item.scope === scope);
        return { key: scope, estimatedHeight: session ? 310 : 100, content: <Card className={styles.panel}>
          <strong>{scope === "local" ? t("本地连接") : t("Remote SSH 连接")}</strong>
          {!session ? <p>{t("尚未运行诊断，请从上方开始验证。")}</p> : <>
            <small>{t("创建于 {time}", { time: new Date(session.created_at_ms).toLocaleString() })}</small>
            <p>{scope === "local" ? t("请在本地 Cursor 窗口的新对话发送以下指令。") : t("请在已连接 SSH 的 Cursor 窗口的新对话发送以下指令。诊断记录对应你选择的窗口类型。")}</p>
            <div className={styles.instruction}><code>{diagnosticInstruction(session.marker)}</code><Button variant="secondary" onClick={() => void api.copyCursorText(diagnosticInstruction(session.marker)).then(() => message(t("已复制"))).catch((cause) => message(String(cause)))}>{t("复制指令")}</Button></div>
            <div className={styles.evidence}>{connectionSteps(session).map((step) => <div key={step.key} data-state={step.state}><strong>{stepLabels[step.key]}</strong><span>{step.state === "passed" ? t("已验证") : step.state === "failed" ? t("失败") : t("等待验证")}</span></div>)}</div>
            {Date.now() - session.created_at_ms > 15 * 60_000 && !session.request_seen_at_ms && <p className={styles.error}>{t("诊断指令已过期，请重新开始验证。")}</p>}
            {session.error_message && <p role="alert" className={styles.error}>{session.error_message}</p>}
            {session.request_id && <small>{t("请求 ID")}：{session.request_id}</small>}
          </>}
        </Card> };
      }),
      { key: "capabilities", estimatedHeight: 80, content: <Card className={styles.panel}><Link to="/model-health">{t("查看模型健康与能力测试")}</Link><small>{t("模型测试独立验证提供商能力；完整连接还需要 Cursor 请求和工具结果。")}</small></Card> },
    ]} />
    {sshHelp && <RemoteSshHelp onClose={() => setSshHelp(false)} />}
  </>;
}
