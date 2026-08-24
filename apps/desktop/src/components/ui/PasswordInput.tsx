import { useState, type InputHTMLAttributes } from "react";
import { api } from "../../api";
import { Icon } from "./Icon";
import { copyIcon, eyeIcon, eyeOffIcon } from "./icons";
import { useMessage } from "./message";
import styles from "./PasswordInput.module.scss";

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  const message = useMessage();

  const copyApiKey = () => {
    if (typeof props.value !== "string" || !props.value) return;
    api.copyCursorText(props.value).then(() => {
      message(t("API Key 已复制到剪贴板"));
    }).catch((error: unknown) => {
      message(error instanceof Error ? error.message : String(error));
    });
  };

  return <div className={styles.container}>
    <input {...props} type={visible ? "text" : "password"} className={styles.input} />
    <div className={styles.controls}>
      <button type="button" className={styles.controlButton} aria-label={visible ? t("隐藏密码") : t("显示密码")} onClick={() => setVisible(!visible)}>
        <Icon icon={visible ? eyeOffIcon : eyeIcon} size="1.05em" />
      </button>
      <button type="button" className={styles.controlButton} aria-label={t("复制 API Key")} onClick={copyApiKey}>
        <Icon icon={copyIcon} size="1.05em" />
      </button>
    </div>
  </div>;
}
