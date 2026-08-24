import { useState } from "react";
import type { Provider, ProviderInput } from "../api";
import { ProviderEditor } from "../components/ProviderEditor";
import { ProviderTable } from "../components/ProviderTable";
import { PageContent } from "../components/layout/PageContent";
import controls from "../components/ui/Controls.module.scss";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { TooltipTrigger } from "../components/ui/TooltipTrigger";
import { addIcon } from "../components/ui/icons";
import { useMessage } from "../components/ui/message";
import { PageActions } from "../layouts/PageActions";
import { appStore, useAppStore } from "../store/appStore";
import { defaultCustomHeaders, defaultCustomHeadersText } from "../utils/providerDefaults";
import styles from "./ProvidersPage.module.scss";

const emptyProvider = (): ProviderInput => ({
  name: "",
  provider_type: "openai-chat",
  base_url: "",
  api_key: "",
  custom_headers: { ...defaultCustomHeaders },
  extra_params: {},
});

export function ProvidersPage() {
  const { providers, busy } = useAppStore();
  const message = useMessage();
  const [draft, setDraft] = useState<ProviderInput | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [headersText, setHeadersText] = useState(defaultCustomHeadersText);
  const [extraText, setExtraText] = useState("{}");
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setEditing(null);
    setDraft(emptyProvider());
    setHeadersText(defaultCustomHeadersText);
    setExtraText("{}");
  };
  const openEdit = (provider: Provider) => {
    setEditing(provider);
    setDraft({ name: provider.name, provider_type: provider.provider_type, base_url: provider.base_url, api_key: provider.api_key, custom_headers: provider.custom_headers, extra_params: provider.extra_params });
    setHeadersText(JSON.stringify(provider.custom_headers, null, 2));
    setExtraText(JSON.stringify(provider.extra_params, null, 2));
  };
  const closeEditor = () => {
    if (saving) return;
    setDraft(null);
    setEditing(null);
  };
  const save = async () => {
    if (!draft) return;
    try {
      const name = draft.name.trim();
      const baseUrl = draft.base_url.trim();
      if (!name || !baseUrl) throw new Error(t("名称和 Base URL 不能为空"));
      const input: ProviderInput = {
        ...draft,
        name,
        base_url: baseUrl,
        api_key: editing && !draft.api_key?.trim() ? undefined : draft.api_key,
        custom_headers: parseHeaders(headersText),
        extra_params: parseObject(extraText, t("额外参数")),
      };
      setSaving(true);
      const ok = editing ? await appStore.updateProvider(editing.provider_id, input) : await appStore.createProvider(input);
      if (ok) {
        setDraft(null);
        setEditing(null);
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const content = <ProviderTable providers={providers} onEdit={openEdit} onDelete={(provider) => void appStore.deleteProvider(provider.provider_id)} />;

  return <>
    <PageActions><TooltipTrigger label={t("添加上游")}><button className={controls.iconButton} aria-label={t("添加上游")} disabled={busy} onClick={openNew}><Icon icon={addIcon} size="1.1em" /></button></TooltipTrigger></PageActions>
    <PageContent fixed title={t("上游")} contentClassName={styles.pageContent} sections={[{ key: "providers", estimatedHeight: 720, content }]} />
    <Modal open={draft !== null} title={editing ? t("编辑上游") : t("添加上游")} busy={saving} onClose={closeEditor} onSubmit={() => void save()}>
      {draft && <ProviderEditor value={draft} headersText={headersText} extraText={extraText} editing={editing !== null} onChange={setDraft} onHeadersChange={setHeadersText} onExtraChange={setExtraText} />}
    </Modal>
  </>;
}

function parseHeaders(text: string): Record<string, string | null> {
  const parsed = parseObject(text, t("自定义 Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string" && value !== null)) throw new Error(t("自定义 Headers 的值必须是字符串或 null"));
  return parsed as Record<string, string | null>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}
