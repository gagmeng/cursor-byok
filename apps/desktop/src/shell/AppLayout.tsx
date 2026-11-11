import { useCallback, useEffect, useRef, useState } from "react";
import type { IconifyIcon } from "@iconify/react/offline";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import cursorIconUrl from "../shared/assets/icons/cursor.svg";
import { api } from "../shared/api";
import { PageLayout } from "./layout/PageLayout";
import { Card } from "../shared/ui/Card";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import controls from "../shared/ui/Controls.module.scss";
import { Icon } from "../shared/ui/Icon";
import { TooltipTrigger } from "../shared/ui/TooltipTrigger";
import { chartIcon, connectionIcon, healthIcon, historyIcon, informationOutlineIcon, pluginIcon, reloadIcon, settingsOutlineIcon } from "../shared/ui/icons";
import { useMessage } from "../shared/ui/message";
import { VirtualList } from "../shared/virtual/VirtualList";
import { useI18n } from "../i18n/store";
import { appStore, useAppStore } from "../shared/store/appStore";
import { useUpdateStore } from "../shared/store/updateStore";
import styles from "./AppLayout.module.scss";
import { PageActionsTarget } from "./PageActions";
import { diagnosticsStore } from "../features/diagnostics/diagnosticsStore";

type MenuItem =
  | { kind: "page"; path: string; label: string; icon: IconifyIcon | string }
  | { kind: "external"; id: string; label: string; icon: IconifyIcon | string }
  | { kind: "group"; label: string };

const keptAlivePages = ["/", "/calls", "/settings", "/harness/cursor", "/plugins", "/diagnostics", "/model-health"];
const tutorialReadStorageKey = "cursor-byok:tutorial-read";
// This repository's README is the user guide; the archived upstream docs site is not.
const tutorialUrlByLocale = {
  "zh-CN": "https://github.com/gagmeng/cursor-byok/blob/main/README-CN.md",
  "en-US": "https://github.com/gagmeng/cursor-byok/blob/main/README.md",
  "pt-BR": "https://github.com/gagmeng/cursor-byok/blob/main/README.md",
} as const;

export function AppLayout() {
  const { busy, cursorHarness } = useAppStore();
  const { availableVersion } = useUpdateStore();
  const { locale } = useI18n();
  const message = useMessage();
  const location = useLocation();
  const navigate = useNavigate();
  const checkedOnboarding = useRef(false);
  useEffect(() => {
    if (!cursorHarness || checkedOnboarding.current) return;
    checkedOnboarding.current = true;
    if (cursorHarness.configured_models === 0 && cursorHarness.ca !== "ready" && location.pathname === "/") navigate("/diagnostics", { replace: true });
  }, [cursorHarness, location.pathname, navigate]);
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  const [confirmTutorial, setConfirmTutorial] = useState(false);
  const [tutorialRead, setTutorialRead] = useState(() => {
    try {
      return localStorage.getItem(tutorialReadStorageKey) === "true";
    } catch {
      return false;
    }
  });
  const menuItems: MenuItem[] = [
    { kind: "page", path: "/", label: t("数据概览"), icon: chartIcon },
    { kind: "page", path: "/calls", label: t("调用详细"), icon: historyIcon },
    { kind: "page", path: "/diagnostics", label: t("连接诊断"), icon: connectionIcon },
    { kind: "page", path: "/model-health", label: t("模型健康"), icon: healthIcon },
    { kind: "group", label: t("模型配置") },
    { kind: "page", path: "/harness/cursor", label: "Cursor", icon: cursorIconUrl },
    { kind: "group", label: t("设置") },
    { kind: "page", path: "/plugins", label: t("插件配置"), icon: pluginIcon },
    { kind: "page", path: "/settings", label: t("系统设置"), icon: settingsOutlineIcon },
    { kind: "external", id: "tutorial", label: t("使用教程"), icon: informationOutlineIcon },
  ];

  const openTutorial = useCallback(() => {
    setConfirmTutorial(false);
    void api.openExternalUrl(tutorialUrlByLocale[locale])
      .then(() => {
        setTutorialRead(true);
        try {
          localStorage.setItem(tutorialReadStorageKey, "true");
        } catch {
          // Read state remains valid for the current session when storage is unavailable.
        }
      })
      .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [locale, message]);

  return <PageLayout className={styles.root}>
    <Card as="aside" className={styles.menuCard}>
      <nav className={styles.navigation} aria-label={t("主菜单")}>
        <VirtualList
          items={menuItems}
          itemKey={(item) => item.kind === "group" ? `group-${item.label}` : item.kind === "external" ? `external-${item.id}` : item.path}
          estimatedItemHeight={36}
          itemGap={4}
          className={`${styles.navigationList} scroll-shadow-bottom`}
        >
          {(item) => item.kind === "group"
          ? <div className={styles.navigationGroup} key={`group-${item.label}`}>{item.label}</div>
          : item.kind === "external"
          ? <div className={styles.navigationRow} key={item.id}>
            <button
              type="button"
              aria-label={`${item.label}${tutorialRead ? "" : `，${t("未读")}`}`}
              onClick={() => setConfirmTutorial(true)}
            >
              {typeof item.icon === "string"
                ? <Icon src={item.icon} size="1.3em" />
                : <Icon icon={item.icon} size="1.3em" />}
              <span>{item.label}</span>
              {!tutorialRead && <span className={styles.menuIndicatorDot} aria-hidden="true" />}
            </button>
          </div>
          : <div className={styles.navigationRow} key={item.path}>
            <NavLink to={item.path} end={item.path === "/"}>
              {typeof item.icon === "string"
                ? <Icon src={item.icon} size="1.3em" />
                : <Icon icon={item.icon} size="1.3em" />}
              <span>{item.label}</span>
              {item.path === "/harness/cursor" && cursorHarness && <span
                className={styles.menuStatusTag}
                data-taken={cursorHarness.settings_applied || undefined}
                title={t("仅表示本机代理配置，不验证 Remote SSH 连接。")}
              >
                {cursorHarness.settings_applied ? t("本地已接管") : t("本地未接管")}
              </span>}
              {item.path === "/settings" && availableVersion && <span className={styles.menuIndicatorDot} aria-hidden="true" />}
            </NavLink>
          </div>}
        </VirtualList>
      </nav>
    </Card>
    <ConfirmDialog
      id="open-tutorial-dialog"
      open={confirmTutorial}
      title={t("打开使用教程？")}
      cancelLabel={t("取消")}
      confirmLabel={t("打开教程")}
      onCancel={() => setConfirmTutorial(false)}
      onConfirm={openTutorial}
    >
      <p>{t("将在系统浏览器中打开使用教程，是否继续？")}</p>
    </ConfirmDialog>
    <main className={styles.content}>
      <div className={styles.actionRegion}>
        <Card className={styles.actions}>
          <div ref={setLeftActionTarget} className={styles.pageActions} />
          {location.pathname !== "/" && <TooltipTrigger label={t("刷新")}><button className={controls.iconButton} aria-label={t("刷新")} disabled={busy} onClick={() => void appStore.refresh().then(() => location.pathname === "/diagnostics" || location.pathname === "/model-health" ? diagnosticsStore.refresh() : undefined)}>
            <Icon className={busy ? controls.spin : ""} icon={reloadIcon} size="1.1em" />
          </button></TooltipTrigger>}
          <div ref={setRightActionTarget} className={styles.pageActions} />
        </Card>
      </div>
      <PageActionsTarget.Provider value={{ left: leftActionTarget, right: rightActionTarget }}>
        <KeepAliveRouteOutlet
          activeCacheKey={location.pathname}
          include={keptAlivePages}
          max={keptAlivePages.length}
          enableActivity
          containerClassName={styles.keepAliveContainer}
          cacheNodeClassName={styles.keepAlivePage}
        />
      </PageActionsTarget.Provider>
    </main>
  </PageLayout>;
}
