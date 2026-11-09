//! 展示内置和插件 Cursor 模型及各模型的操作入口。
import type { IconifyIcon } from "@iconify/react/offline";
import { type ReactNode } from "react";
import type { Model, PluginModelDescriptor } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon, chevronRightIcon, claudeIcon, editIcon, flatColorOrganizationIcon, openAiIcon, trashIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";

import type { CursorModelGroup, CursorModelGrouping, CursorPluginGroup } from "./cursorModelGrouping";

type CursorModelCardsProps = {
  models: Model[];
  groups: CursorModelGroup[];
  pluginGroups: CursorPluginGroup[];
  grouping: CursorModelGrouping;
  openGroupIds: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: Model) => void;
  onEdit: (model: Model) => void;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onTestPluginModel: (model: PluginModelDescriptor) => void;
  onPluginSettings: (model: PluginModelDescriptor) => void;
  onSystemPrompt: (modelId: string, displayName: string) => void;
  onGroupSettings: (group: CursorModelGroup) => void;
  onGroupDelete: (group: CursorModelGroup) => void;
};

// 平铺与分组共用同一套卡片:同一模型在两种视图下必须是同一种卡片、同一尺寸。
export function CursorModelCards(props: CursorModelCardsProps) {
  const builtinCards = (models: Model[]) => <ModelCardGrid>{models.map((model) => {
    const testing = props.testingModelHashes.has(model.model_hash);
    return <ModelCard
      key={model.model_hash}
      modelKey={model.model_hash}
      name={model.display_name}
      modelId={model.model_id}
      badgeIcon={model.type === "anthropic" ? claudeIcon : openAiIcon}
      badgeLabel={model.type === "anthropic" ? "Anthropic" : "OpenAI"}
      testing={testing}
      result={props.testResults.get(model.model_hash)}
      actions={<>
        <TruncatedButton size="small" disabled={props.disabled && !testing} label={testing ? t("停止") : t("测试")} onClick={() => props.onTest(model)} />
        <TruncatedButton size="small" disabled={props.disabled} label={t("编辑")} onClick={() => props.onEdit(model)} />
        <TruncatedButton size="small" disabled={props.disabled} label={t("系统提示词")} onClick={() => props.onSystemPrompt(model.model_hash, model.display_name)} />
        <TruncatedButton size="small" disabled={props.disabled} label={t("复制")} onClick={() => props.onDuplicate(model)} />
        <TruncatedButton size="small" className={styles.deleteButton} disabled={props.disabled} label={t("删除")} onClick={() => props.onDelete(model)} />
      </>}
    />;
  })}</ModelCardGrid>;
  const pluginCards = (models: PluginModelDescriptor[]) => <ModelCardGrid>{models.map((model) => {
    const testing = props.testingModelHashes.has(model.id);
    return <ModelCard
      key={model.id}
      modelKey={model.id}
      name={model.displayName}
      modelId={model.modelId}
      badgeIconSrc={model.icon}
      badgeLabel={model.pluginName}
      testing={testing}
      result={props.testResults.get(model.id)}
      actions={<>
        <TruncatedButton size="small" disabled={props.disabled && !testing} label={testing ? t("停止") : t("测试")} onClick={() => props.onTestPluginModel(model)} />
        <TruncatedButton size="small" disabled={props.disabled} label={t("设置")} onClick={() => props.onPluginSettings(model)} />
        <TruncatedButton size="small" disabled={props.disabled} label={t("系统提示词")} onClick={() => props.onSystemPrompt(model.id, model.displayName)} />
      </>}
    />;
  })}</ModelCardGrid>;

  if (props.grouping === "flat") {
    // 平铺视图插件模型与内置模型同为卡片,归属靠卡片徽章表达。
    return <div className={styles.modelGroups}>
      {builtinCards(props.models)}
      {pluginCards(props.pluginGroups.flatMap((group) => group.models))}
    </div>;
  }
  return <div className={styles.modelGroups}>
    {props.groups.map((group) => <CollapsibleGroup
      key={group.id}
      label={group.label}
      icon={props.grouping === "provider" ? flatColorOrganizationIcon : group.key === "anthropic" ? claudeIcon : openAiIcon}
      open={props.openGroupIds.has(group.id)}
      onToggle={() => props.onToggleGroup(group.id)}
      onSettings={props.grouping === "provider" ? () => props.onGroupSettings(group) : undefined}
      onDelete={props.grouping === "provider" ? () => props.onGroupDelete(group) : undefined}
    >
      {builtinCards(group.models)}
    </CollapsibleGroup>)}
    {props.pluginGroups.map((group) => <CollapsibleGroup
      key={group.id}
      label={group.pluginName}
      iconSrc={group.icon}
      open={props.openGroupIds.has(group.id)}
      onToggle={() => props.onToggleGroup(group.id)}
    >
      {pluginCards(group.models)}
    </CollapsibleGroup>)}
  </div>;
}

function ModelCardGrid({ children }: { children: ReactNode }) {
  return <div className={styles.modelGrid}>{children}</div>;
}

function CollapsibleGroup({ label, icon, iconSrc, open, onToggle, onSettings, onDelete, children }: {
  label: string;
  icon?: IconifyIcon;
  iconSrc?: string;
  open: boolean;
  onToggle: () => void;
  onSettings?: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  return <Card className={styles.groupCard}>
    <div className={styles.groupHeader}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={onToggle}
      >
        {icon && <Icon icon={icon} size="1.1em" />}
        {iconSrc && <Icon src={iconSrc} size="1.1em" />}
        <span className={styles.groupLabel}>{label}</span>
      </button>
      {/* 图标命令不占文字宽度:分组名再长也能完整显示,含义由逐项悬停提示承担。 */}
      {onSettings && <TooltipTrigger label={t("分组设置")}>
        <button type="button" className={styles.groupCommand} aria-label={t("分组设置")} onClick={onSettings}>
          <Icon icon={editIcon} size="1em" />
        </button>
      </TooltipTrigger>}
      {onDelete && <TooltipTrigger label={t("分组删除")}>
        <button type="button" className={`${styles.groupCommand} ${styles.groupDelete}`} aria-label={t("分组删除")} onClick={onDelete}>
          <Icon icon={trashIcon} size="1em" />
        </button>
      </TooltipTrigger>}
      <button
        type="button"
        className={styles.groupChevron}
        tabIndex={-1}
        aria-hidden="true"
        onClick={onToggle}
      >
        <Icon icon={open ? chevronDownIcon : chevronRightIcon} size="1em" />
      </button>
    </div>
    {open && <div className={styles.modelList}>{children}</div>}
  </Card>;
}

/** 模型卡片:名称与归属徽章在顶部,测试状态条横跨卡片,操作按钮在底部。 */
function ModelCard({ modelKey, name, modelId, badgeIcon, badgeIconSrc, badgeLabel, testing, result, actions }: {
  modelKey: string;
  name: string;
  modelId: string;
  badgeIcon?: IconifyIcon;
  badgeIconSrc?: string;
  badgeLabel: string;
  testing: boolean;
  result: CursorModelTestState | undefined;
  actions: ReactNode;
}) {
  return <Card className={styles.modelCard} data-model-key={modelKey}>
    <div className={styles.modelCardContent}>
      <div className={styles.modelCardTop}>
        <div className={styles.modelCardName}>
          <span className={styles.modelCardNameText}>{name}</span>
          <span className={styles.modelCardModelId}>{modelId}</span>
        </div>
        <span className={styles.modelTypeBadge}>
          {badgeIconSrc ? <Icon src={badgeIconSrc} /> : badgeIcon && <Icon icon={badgeIcon} />}
          {badgeLabel}
        </span>
      </div>
      <div className={styles.modelCardTest}>
        <CursorModelTestResult state={result} testing={testing} />
      </div>
      <div className={styles.modelCardActions}>{actions}</div>
    </div>
  </Card>;
}
