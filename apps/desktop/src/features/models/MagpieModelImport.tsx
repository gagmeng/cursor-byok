import { useMemo, useRef, useState } from "react";
import { api, type MagpieImportModel, type MagpieImportPreview } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon, chevronRightIcon } from "../../shared/ui/icons";
import { TextInput } from "../../shared/ui/FormControls";
import { useMessage } from "../../shared/ui/message";
import styles from "./MagpieModelImport.module.scss";

type ProviderGroup = {
  /** 分组键,同时也是供应商名;路由组共用一个键。 */
  id: string;
  /** magpie 的路由组(auto/*、group/*):一条 id 在多个供应商之间负载均衡。 */
  routingGroup: boolean;
  models: MagpieImportModel[];
};

/** magpie 的默认网关,也是地址输入框第一次打开时的预填值。 */
const DEFAULT_GATEWAY_ADDRESS = "127.0.0.1:3425";
/** 记住用户上次查询成功的地址,下次打开直接预填,不必重新输入非默认端口。 */
const ADDRESS_STORAGE_KEY = "cursor-byok.magpie-address";
/** 所有路由组共用一个分组键:它们同属 magpie 的跨供应商入口,不该按成员供应商拆开。 */
const ROUTING_GROUP_ID = "routing-group";

/** 「常用预设」中的 Magpie 项:查询网关目录,勾选后批量建模型。 */
export type MagpieModelImport = {
  open: boolean;
  /** 查询或导入进行中,用于禁用触发入口。 */
  busy: boolean;
  previewing: boolean;
  importing: boolean;
  /** 网关地址;为空时由服务端按 MAGPIE_ADDR / settings.json / 默认端口自行探测。 */
  address: string;
  preview: MagpieImportPreview | null;
  selected: Set<string>;
  groups: ProviderGroup[];
  /** 折叠的分组 id；默认全部展开。 */
  collapsed: ReadonlySet<string>;
  selectableCount: number;
  selectedNew: number;
  /** 打开弹窗;不发起任何网络请求,查询由用户点击触发。 */
  start: () => void;
  close: () => void;
  setAddress: (address: string) => void;
  /** 用当前地址查询网关目录。 */
  query: () => void;
  toggle: (modelId: string, checked: boolean) => void;
  toggleGroup: (models: MagpieImportModel[], checked: boolean) => void;
  toggleCollapsed: (groupId: string) => void;
  confirm: () => void;
};

/** 查询 magpie 网关目录并批量导入其模型;状态归调用方,弹窗由 <MagpieModelImportDialog> 渲染。 */
export function useMagpieModelImport(): MagpieModelImport {
  const message = useMessage();
  const [open, setOpen] = useState(false);
  const [address, setAddressState] = useState(readStoredAddress);
  const [preview, setPreview] = useState<MagpieImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  // 每次打开、关闭或重新查询都会推进世代:晚到的旧响应属于上一个生命周期,必须丢弃。
  const generation = useRef(0);

  const groups = useMemo(() => groupByProvider(preview?.models ?? []), [preview]);
  const selectable = useMemo(() => (preview?.models ?? []).filter((model) => !model.existing), [preview]);
  const selectedNew = selectable.filter((model) => selected.has(model.model_id)).length;

  const start = () => {
    generation.current += 1;
    setOpen(true);
    setPreview(null);
    setSelected(new Set());
    setCollapsed(new Set());
    setPreviewing(false);
  };

  const close = () => {
    if (importing) return;
    generation.current += 1;
    setOpen(false);
    setPreview(null);
    setPreviewing(false);
  };

  const setAddress = (value: string) => {
    setAddressState(value);
    // 地址变了,上一次的结果就不再对应当前输入,免得用户对着旧列表点导入。
    setPreview(null);
    setSelected(new Set());
    setCollapsed(new Set());
  };

  const query = () => {
    const current = generation.current;
    const target = address.trim();
    void (async () => {
      try {
        setPreviewing(true);
        const result = await api.previewMagpieModels(target || undefined);
        if (current !== generation.current) return;
        setAddressState(result.address);
        storeAddress(result.address);
        setPreview(result);
        setCollapsed(new Set());
        // 默认勾选供应商下尚未导入的模型。路由组是别的模型的负载均衡入口,
        // 导入后会与成员模型重复占位,默认留给用户自己决定。
        setSelected(new Set(result.models.filter((model) => !model.existing && !model.routing_group).map((model) => model.model_id)));
      } catch (cause) {
        if (current !== generation.current) return;
        message(errorText(cause));
      } finally {
        if (current === generation.current) setPreviewing(false);
      }
    })();
  };

  const toggle = (modelId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  };

  const toggleGroup = (models: MagpieImportModel[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of models) {
        if (model.existing) continue;
        if (checked) next.add(model.model_id);
        else next.delete(model.model_id);
      }
      return next;
    });
  };

  const toggleCollapsed = (provider: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  const confirm = () => {
    if (!preview) return;
    void (async () => {
      try {
        setImporting(true);
        const result = await appStore.importMagpieModels(
          preview.models.filter((model) => selected.has(model.model_id)).map((model) => model.model_id),
          preview.address,
        );
        if (!result) {
          const error = appStore.getSnapshot().error;
          if (error) message(error);
          return;
        }
        generation.current += 1;
        setOpen(false);
        setPreview(null);
        message(result.imported > 0
          ? t("导入完成：新增 {imported} 个模型，跳过 {skipped} 个已存在模型", { imported: result.imported, skipped: result.skipped })
          : t("选中的 {count} 个模型均已存在，无需重复导入", { count: result.skipped }));
      } catch (cause) {
        message(errorText(cause));
      } finally {
        setImporting(false);
      }
    })();
  };

  return {
    open,
    busy: previewing || importing,
    previewing,
    importing,
    address,
    preview,
    selected,
    groups,
    collapsed,
    selectableCount: selectable.length,
    selectedNew,
    start,
    close,
    setAddress,
    query,
    toggle,
    toggleGroup,
    toggleCollapsed,
    confirm,
  };
}

export function MagpieModelImportDialog({ state }: { state: MagpieModelImport }) {
  const { open, address, preview, previewing, importing, selected, groups, selectedNew, selectableCount } = state;
  return <ConfirmDialog
    open={open}
    title={t("从 magpie 导入模型")}
    busy={importing}
    wide
    cancelLabel={t("取消")}
    confirmLabel={t("导入选中的 {count} 个模型", { count: selectedNew })}
    confirmDisabled={selectedNew === 0 || previewing}
    onCancel={state.close}
    onConfirm={state.confirm}
  >
    <div className={styles.content}>
      <div className={styles.address}>
        <span>{t("网关地址")}</span>
        <div className={styles.addressRow}>
          <TextInput
            aria-label={t("网关地址")}
            placeholder={DEFAULT_GATEWAY_ADDRESS}
            value={address}
            disabled={importing}
            onChange={(event) => state.setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || previewing) return;
              event.preventDefault();
              state.query();
            }}
          />
          <Button disabled={previewing || importing} onClick={state.query}>
            {previewing ? t("查询中…") : t("查询")}
          </Button>
        </div>
        <small>{t("留空时自动探测本机 magpie；改端口后重新查询即可。")}</small>
      </div>
      {previewing && <small className={styles.hint}>{t("正在读取网关的模型目录…")}</small>}
      {!preview && !previewing && <small className={styles.hint}>{t("点击查询，列出该网关当前可用的模型。")}</small>}
      {preview && <>
        <div className={styles.source}>
          <strong>{t("magpie 网关")}</strong>
          <code>{preview.address} · magpie {preview.version}</code>
        </div>
        <div className={styles.counts}>
          <div><strong>{preview.models.length}</strong><small>{t("可用模型")}</small></div>
          <div><strong>{preview.models.length - selectableCount}</strong><small>{t("已存在")}</small></div>
          <div><strong>{selectedNew}</strong><small>{t("已勾选")}</small></div>
        </div>
        {preview.models.length === 0
          ? <small className={styles.hint}>{t("magpie 里还没有启用任何模型。先在 magpie 中启用供应商或登录账号，再回到这里重新查询。")}</small>
          : <div className={styles.groups}>
            {groups.map((group) => {
              const fresh = group.models.filter((model) => !model.existing);
              const checked = fresh.length > 0 && fresh.every((model) => selected.has(model.model_id));
              const folded = state.collapsed.has(group.id);
              const name = group.routingGroup ? t("路由组") : group.id;
              return <section key={group.id} className={styles.group}>
                <header className={styles.groupHeader}>
                  <button
                    type="button"
                    className={styles.groupToggle}
                    aria-expanded={!folded}
                    aria-label={folded
                      ? t("展开 {name} 分组", { name })
                      : t("折叠 {name} 分组", { name })}
                    onClick={() => state.toggleCollapsed(group.id)}
                  >
                    <Icon icon={folded ? chevronRightIcon : chevronDownIcon} size="1em" />
                  </button>
                  <Checkbox
                    checked={checked}
                    disabled={importing || fresh.length === 0}
                    label={`${name} (${fresh.length}/${group.models.length})`}
                    onChange={(next) => state.toggleGroup(group.models, next)}
                  />
                  {group.routingGroup && <small className={styles.note}>{t("magpie 的路由组：同一条 id 在多个供应商之间分配请求；成员模型已在各自供应商分组里。")}</small>}
                </header>
                {!folded && <div className={styles.models}>
                  {group.models.map((model) => <div className={styles.model} key={model.model_id}>
                    <Checkbox
                      checked={selected.has(model.model_id)}
                      disabled={importing || model.existing}
                      label={model.display_name}
                      onChange={(next) => state.toggle(model.model_id, next)}
                    />
                    <small>{model.model_id} · {endpointLabel(model.endpoint)}{model.context_window_tokens ? ` · ${formatTokens(model.context_window_tokens)}` : ""}</small>
                    {model.existing && <span className={styles.existing}>{t("已存在")}</span>}
                  </div>)}
                </div>}
              </section>;
            })}
          </div>}
        <small className={styles.hint}>{t("导入后模型指向本地 magpie 网关；重复导入相同模型会自动跳过。")}</small>
      </>}
    </div>
  </ConfirmDialog>;
}

/** 按供应商分组;所有路由组合并成一组并排到最后,不与供应商模型混排。 */
function groupByProvider(models: MagpieImportModel[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const model of models) {
    const id = model.routing_group ? ROUTING_GROUP_ID : model.provider;
    const group = groups.get(id);
    if (group) group.models.push(model);
    else groups.set(id, { id, routingGroup: model.routing_group, models: [model] });
  }
  return [...groups.values()].sort((left, right) => Number(left.routingGroup) - Number(right.routingGroup));
}

function readStoredAddress() {
  try {
    return localStorage.getItem(ADDRESS_STORAGE_KEY) || DEFAULT_GATEWAY_ADDRESS;
  } catch {
    return DEFAULT_GATEWAY_ADDRESS;
  }
}

function storeAddress(address: string) {
  try {
    localStorage.setItem(ADDRESS_STORAGE_KEY, address);
  } catch {
    // 存不下不影响本次查询结果,下次打开回落到默认地址即可。
  }
}

function endpointLabel(endpoint: MagpieImportModel["endpoint"]) {
  switch (endpoint) {
    case "anthropic": return "Anthropic";
    case "openai-responses": return "OpenAI Responses";
    default: return "OpenAI Chat";
  }
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000 * 10) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
