//! 展示内置和插件 Cursor 模型及各模型的操作入口。
import type { IconifyIcon } from "@iconify/react/offline";
import { useEffect, useRef, type ReactNode } from "react";
import Sortable from "sortablejs";
import type { Model, PluginModelDescriptor } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon, chevronRightIcon, claudeIcon, dragIcon, editIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
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
  onReorder: (modelHashes: string[]) => void;
  onGroupSettings: (group: CursorModelGroup) => void;
};

type ModelGridProps = Omit<CursorModelCardsProps, "grouping" | "groups" | "pluginGroups" | "openGroupIds" | "onToggleGroup" | "onTestPluginModel" | "onPluginSettings"> & {
  sortable: boolean;
};

export function CursorModelCards(props: CursorModelCardsProps) {
  const builtins = props.grouping === "flat"
    ? <div style={{ paddingTop: "10px" }}><ModelGrid {...props} sortable /></div>
    : <div className={styles.modelGroups}>
      {props.groups.map((group) => <CollapsibleGroup
        key={group.id}
        label={group.label}
        icon={props.grouping === "provider" ? flatColorOrganizationIcon : group.key === "anthropic" ? claudeIcon : openAiIcon}
        open={props.openGroupIds.has(group.id)}
        onToggle={() => props.onToggleGroup(group.id)}
        onSettings={props.grouping === "provider" ? () => props.onGroupSettings(group) : undefined}
      >
        {group.models.map((model) => <ModelListRow
          key={model.model_hash}
          model={model}
          disabled={props.disabled}
          testing={props.testingModelHashes.has(model.model_hash)}
          result={props.testResults.get(model.model_hash)}
          onTest={() => props.onTest(model)}
          onEdit={() => props.onEdit(model)}
          onDuplicate={() => props.onDuplicate(model)}
          onDelete={() => props.onDelete(model)}
          onSystemPrompt={() => props.onSystemPrompt(model.model_hash, model.display_name)}
        />)}
      </CollapsibleGroup>)}
    </div>;
  // 平铺视图下插件模型与内置模型同为卡片,归属靠卡片徽章表达;
  // 分组视图保留插件分组容器。
  const plugins = props.grouping === "flat"
    ? <div style={{ paddingTop: "10px" }}><PluginModelGrid
      models={props.pluginGroups.flatMap((group) => group.models)}
      disabled={props.disabled}
      testingModelHashes={props.testingModelHashes}
      testResults={props.testResults}
      onTest={props.onTestPluginModel}
      onSettings={props.onPluginSettings}
      onSystemPrompt={props.onSystemPrompt}
    /></div>
    : props.pluginGroups.map((group) => <CollapsibleGroup
      key={group.id}
      label={group.pluginName}
      iconSrc={group.icon}
      open={props.openGroupIds.has(group.id)}
      onToggle={() => props.onToggleGroup(group.id)}
    >
      {group.models.map((model) => <PluginModelRow
        key={model.id}
        model={model}
        disabled={props.disabled}
        testing={props.testingModelHashes.has(model.id)}
        result={props.testResults.get(model.id)}
        onTest={() => props.onTestPluginModel(model)}
        onSettings={() => props.onPluginSettings(model)}
        onSystemPrompt={() => props.onSystemPrompt(model.id, model.displayName)}
      />)}
    </CollapsibleGroup>);
  return <div className={styles.modelGroups}>
    {builtins}
    {plugins}
  </div>;
}

function CollapsibleGroup({ label, icon, iconSrc, open, onToggle, onSettings, children }: {
  label: string;
  icon?: IconifyIcon;
  iconSrc?: string;
  open: boolean;
  onToggle: () => void;
  onSettings?: () => void;
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
      {onSettings && <button type="button" className={styles.groupSettings} onClick={onSettings}>
        <Icon icon={editIcon} size="1em" />
        {t("分组设置")}
      </button>}
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

function ModelListRow({ model, disabled, testing, result, onTest, onEdit, onDuplicate, onDelete, onSystemPrompt }: {
  model: Model;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSystemPrompt: () => void;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText}>{model.display_name}</span>
      <span className={styles.modelRowModelId}>{model.model_id}</span>
    </div>
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={onTest} />
      <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={onEdit} />
      <TruncatedButton size="small" disabled={disabled} label={t("系统提示词")} onClick={onSystemPrompt} />
      <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={onDuplicate} />
      <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={onDelete} />
    </div>
  </div>;
}

function PluginModelRow({ model, disabled, testing, result, onTest, onSettings, onSystemPrompt }: {
  model: PluginModelDescriptor;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onSettings: () => void;
  onSystemPrompt: () => void;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText}>{model.displayName}</span>
      <span className={styles.modelRowModelId}>{model.modelId}</span>
    </div>
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={onTest} />
      <TruncatedButton size="small" disabled={disabled} label={t("设置")} onClick={onSettings} />
      <TruncatedButton size="small" disabled={disabled} label={t("系统提示词")} onClick={onSystemPrompt} />
    </div>
  </div>;
}

/** 平铺视图的插件模型卡片:与内置卡片同构,徽章承载插件归属,不可拖拽排序。 */
function PluginModelGrid({
  models,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onSettings,
  onSystemPrompt,
}: {
  models: PluginModelDescriptor[];
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: PluginModelDescriptor) => void;
  onSettings: (model: PluginModelDescriptor) => void;
  onSystemPrompt: (modelId: string, displayName: string) => void;
}) {
  return <div className={styles.modelGrid}>
    {models.map((model) => {
      const result = testResults.get(model.id);
      const testing = testingModelHashes.has(model.id);
      return <Card className={styles.modelCard} key={model.id}>
        <div className={styles.modelCardContent}>
          <div className={styles.modelCardTop}>
            <div className={styles.modelCardName}>
              <span className={styles.modelCardNameText}>{model.displayName}</span>
              <span className={styles.modelCardModelId}>{model.modelId}</span>
            </div>
            <span className={styles.modelTypeBadge}>
              <Icon src={model.icon} />
              {model.pluginName}
            </span>
          </div>
          <div className={styles.modelCardTest}>
            <CursorModelTestResult state={result} testing={testing} />
          </div>
          <div className={styles.modelCardActions}>
            <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={() => onTest(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("设置")} onClick={() => onSettings(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("系统提示词")} onClick={() => onSystemPrompt(model.id, model.displayName)} />
          </div>
        </div>
      </Card>;
    })}
  </div>;
}

function ModelGrid({
  models,
  sortable: sortableEnabled,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
  onSystemPrompt,
  onReorder,
}: ModelGridProps) {
  const grid = useRef<HTMLDivElement>(null);
  const sortable = useRef<Sortable | null>(null);
  const currentModels = useRef(models);
  const reorder = useRef(onReorder);
  currentModels.current = models;
  reorder.current = onReorder;

  useEffect(() => {
    if (!sortableEnabled || !grid.current) return;
    sortable.current = Sortable.create(grid.current, {
      animation: 160,
      dataIdAttr: "data-model-hash",
      draggable: `.${styles.modelCard}`,
      handle: `.${styles.sortHandle}`,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onEnd: (event) => {
        const oldIndex = event.oldDraggableIndex ?? event.oldIndex;
        const newIndex = event.newDraggableIndex ?? event.newIndex;
        if (typeof oldIndex !== "number"
          || typeof newIndex !== "number"
          || oldIndex === newIndex) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        const reordered = currentModels.current.slice();
        const [moved] = reordered.splice(oldIndex, 1);
        if (!moved || newIndex < 0 || newIndex > reordered.length) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        reordered.splice(newIndex, 0, moved);
        reorder.current(reordered.map((model) => model.model_hash));
      },
    });
    return () => {
      sortable.current?.destroy();
      sortable.current = null;
    };
  }, [sortableEnabled]);

  useEffect(() => {
    sortable.current?.option("disabled", disabled);
    sortable.current?.sort(models.map((model) => model.model_hash), false);
  }, [disabled, models]);

  return <div ref={grid} className={styles.modelGrid}>
    {models.map((model) => {
      const result = testResults.get(model.model_hash);
      const testing = testingModelHashes.has(model.model_hash);
      return <Card className={styles.modelCard} data-model-hash={model.model_hash} key={model.model_hash}>
        {sortableEnabled && <button type="button" className={styles.sortHandle} disabled={disabled} aria-label={t("拖动排序")} title={t("拖动排序")} onClick={(event) => event.stopPropagation()}>
          <Icon icon={dragIcon} size="1.25em" />
        </button>}
        <div className={styles.modelCardContent}>
          <div className={styles.modelCardTop}>
            <div className={styles.modelCardName}>
              <span className={styles.modelCardNameText}>{model.display_name}</span>
              <span className={styles.modelCardModelId}>{model.model_id}</span>
            </div>
            <span className={styles.modelTypeBadge}>
              <Icon icon={model.type === "anthropic" ? claudeIcon : openAiIcon} />
              {model.type === "anthropic" ? "Anthropic" : "OpenAI"}
            </span>
          </div>
          <div className={styles.modelCardTest}>
            <CursorModelTestResult state={result} testing={testing} />
          </div>
          <div className={styles.modelCardActions}>
            <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={() => onTest(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={() => onEdit(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("系统提示词")} onClick={() => onSystemPrompt(model.model_hash, model.display_name)} />
            <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={() => onDuplicate(model)} />
            <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={() => onDelete(model)} />
          </div>
        </div>
      </Card>;
    })}
  </div>;
}
