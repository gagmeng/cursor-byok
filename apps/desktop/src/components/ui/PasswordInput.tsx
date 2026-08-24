import { useState, type InputHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { TooltipTrigger } from "./TooltipTrigger";
import { eyeIcon, eyeOffIcon, copyIcon } from "./icons";
import { useMessage } from "./message";
import styles from "./PasswordInput.module.scss";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  showCopyButton?: boolean;
};

export function PasswordInput({ showCopyButton = true, value, onChange, ...props }: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);
  const message = useMessage();

  const toggleShowPassword = () => {
    setShowPassword(!showPassword);
  };

  const copyToClipboard = () => {
    if (typeof value === "string") {
      navigator.clipboard.writeText(value);
      message(t("API Key 已复制到剪贴板"));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (onChange) {
      onChange(e);
    }
  };

  return (
    <div className={styles.container}>
      <input
        {...props}
        type={showPassword ? "text" : "password"}
        value={value}
        onChange={handleChange}
        className={[styles.input, props.className].filter(Boolean).join(" ")}
      />
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.toggleButton}
          onClick={toggleShowPassword}
          aria-label={showPassword ? t("隐藏密码") : t("显示密码")}
        >
          <Icon icon={showPassword ? eyeOffIcon : eyeIcon} size="1.1em" />
        </button>
        {showCopyButton && (
          <button
            type="button"
            className={styles.copyButton}
            onClick={copyToClipboard}
            aria-label={t("复制 API Key")}
          >
            <Icon icon={copyIcon} size="1.1em" />
          </button>
        )}
      </div>
    </div>
  );
}