import { useId, type ReactNode } from "react";
import { Modal } from "./Modal";

export function ConfirmDialog({ id, open, title, children, busy, wide, cancelLabel = t("取消"), confirmLabel = t("确认"), confirmDisabled, onCancel, onConfirm }: {
  id?: string;
  open: boolean;
  title: string;
  children: ReactNode;
  busy?: boolean;
  wide?: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const contentId = useId();
  return <Modal
    id={id}
    open={open}
    title={title}
    busy={busy}
    wide={wide}
    role="alertdialog"
    ariaDescribedBy={contentId}
    initialFocus="submit"
    closeLabel={cancelLabel}
    submitLabel={confirmLabel}
    submitDisabled={confirmDisabled}
    onClose={onCancel}
    onSubmit={onConfirm}
  >
    <div id={contentId}>{children}</div>
  </Modal>;
}
