import type { ProviderInput, ProviderType } from "../api";
import { FormField, TextInput } from "./ui/FormControls";
import { PasswordInput } from "./ui/PasswordInput";
import { JsonEditor } from "./ui/JsonEditor";
import { Select } from "./ui/Select";
import { claudeIcon, openAiIcon } from "./ui/icons";
import styles from "./ProviderEditor.module.scss";

export function ProviderEditor({ value, headersText, extraText, editing, onChange, onHeadersChange, onExtraChange }: {
  value: ProviderInput;
  headersText: string;
  extraText: string;
  editing: boolean;
  onChange: (value: ProviderInput) => void;
  onHeadersChange: (value: string) => void;
  onExtraChange: (value: string) => void;
}) {
  const patch = (next: Partial<ProviderInput>) => onChange({ ...value, ...next });
  return <div className={styles.form}>
    <FormField className={styles.fullWidth} label={t("名称")}><TextInput placeholder={t("例如：OpenAI")} value={value.name} onChange={(event) => patch({ name: event.target.value })} /></FormField>
    <FormField label={t("协议")} hint={t("选择上游服务使用的请求协议。")}><Select ariaLabel={t("协议")} value={value.provider_type} options={[
      { value: "openai-responses", label: "OpenAI Responses", icon: openAiIcon },
      { value: "openai-chat", label: "OpenAI Chat", icon: openAiIcon },
      { value: "anthropic", label: "Anthropic", icon: claudeIcon },
    ]} onChange={(provider_type) => patch({ provider_type: provider_type as ProviderType })} /></FormField>
    <FormField label="Base URL" hint={t("模型服务的 API 根地址；修改后会同步更新该上游模型的路由身份。")}><TextInput placeholder="https://api.example.com/v1" value={value.base_url} onChange={(event) => patch({ base_url: event.target.value })} /></FormField>
    <FormField className={styles.fullWidth} label="API Key" hint={editing ? t("留空表示保留当前 API Key。") : t("访问模型服务所需的密钥。")}><PasswordInput autoComplete="off" placeholder={editing ? t("留空以保留当前密钥") : "sk-xxxxxx"} value={value.api_key ?? ""} onChange={(event) => patch({ api_key: event.target.value })} /></FormField>
    <FormField className={styles.fullWidth} label={t("自定义 Headers JSON")} hint={t("值必须是字符串；编辑时 null 表示保留对应敏感 Header 的原值。")}><JsonEditor ariaLabel={t("自定义 Headers JSON")} value={headersText} onChange={onHeadersChange} /></FormField>
    <FormField className={styles.fullWidth} label={t("额外参数 JSON")} hint={t("合并到该上游所有模型的请求体。")}><JsonEditor ariaLabel={t("额外参数 JSON")} value={extraText} onChange={onExtraChange} /></FormField>
  </div>;
}
