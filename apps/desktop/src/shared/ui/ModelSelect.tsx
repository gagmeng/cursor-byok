//! Presents configured models with grouped selection and virtualized keyboard navigation.
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconProps } from "./Icon";
import { checkIcon, chevronDownIcon, windowCloseIcon } from "./icons";
import { VirtualList } from "../virtual/VirtualList";
import type { VirtualListApi } from "../virtual/virtualTypes";
import styles from "./ModelSelect.module.scss";

export type ModelSelectOption = {
  value: string;
  label: string;
  group: string;
  icon?: IconProps["icon"];
  iconSrc?: string;
};

type ModelSelectProps = {
  label: string;
  options: ModelSelectOption[];
  disabled?: boolean;
} & (
  | { mode: "single"; value: string; onChange: (value: string) => void }
  | { mode: "multiple"; value: string[]; onChange: (value: string[]) => void }
);

type MenuItem =
  | { kind: "group"; key: string; label: string; options: ModelSelectOption[] }
  | { kind: "option"; key: string; option: ModelSelectOption };

function groupedItems(options: ModelSelectOption[]): MenuItem[] {
  const groups = new Map<string, ModelSelectOption[]>();
  for (const option of options) {
    const group = groups.get(option.group);
    if (group) group.push(option);
    else groups.set(option.group, [option]);
  }
  return [...groups].flatMap(([group, groupOptions]) => [
    { kind: "group" as const, key: `group:${group}`, label: group, options: groupOptions },
    ...groupOptions.map((option) => ({ kind: "option" as const, key: `option:${option.value}`, option })),
  ]);
}

function GroupCheckbox({ label, options, selected, onChange }: {
  label: string;
  options: ModelSelectOption[];
  selected: Set<string>;
  onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectedCount = options.filter((option) => selected.has(option.value)).length;
  const checked = selectedCount === options.length;
  const indeterminate = selectedCount > 0 && !checked;

  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return <label className={styles.group}>
    <input
      ref={input}
      type="checkbox"
      checked={checked}
      aria-checked={indeterminate ? "mixed" : checked}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className={styles.checkbox} data-indeterminate={indeterminate || undefined} aria-hidden="true">
      {checked && <Icon icon={checkIcon} size="0.875em" />}
    </span>
    <span>{label}</span>
  </label>;
}

export function ModelSelect(props: ModelSelectProps) {
  const { label, options, disabled, mode } = props;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listApi = useRef<VirtualListApi | null>(null);
  const active = useRef<string | null>(null);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const activate = (value: string | null) => { active.current = value; setActiveValue(value); };
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 420, maxHeight: 280 });
  const items = useMemo(() => groupedItems(options), [options]);
  const orderedOptions = useMemo(() => items.flatMap(item => item.kind === "option" ? [item.option] : []), [items]);
  const selected = useMemo(
    () => new Set(mode === "multiple" ? props.value : [props.value]),
    [mode, props.value],
  );

  useLayoutEffect(() => {
    if (!open || !root.current || !menu.current) return;
    return autoUpdate(root.current, menu.current, () => void computePosition(root.current!, menu.current!, {
      placement: "bottom-start",
      middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 }), size({
        padding: 10,
        apply: ({ rects, availableWidth, availableHeight }) => setPosition((current) => ({
          ...current,
          width: Math.min(availableWidth, Math.max(420, rects.reference.width)),
          maxHeight: Math.max(120, availableHeight),
        })),
      })],
    }).then(({ x, y }) => setPosition((current) => ({ ...current, left: x, top: y }))));
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || activeValue === null) return;
    menu.current?.focus({ preventScroll: true });
    const index = items.findIndex(item => item.kind === "option" && item.option.value === activeValue);
    listApi.current?.scrollToIndex(index, "auto");
  }, [open, activeValue, items]);

  const navigate = (key: string) => {
    const current = orderedOptions.findIndex(option => option.value === active.current);
    const index = key === "Home" ? 0 : key === "End" ? orderedOptions.length - 1
      : Math.max(0, Math.min(orderedOptions.length - 1, current + (key === "ArrowDown" ? 1 : -1)));
    activate(orderedOptions[index]?.value ?? null);
  };

  const summary = mode === "multiple"
    ? props.value.length === 0 ? t("全部") : t("已选 {count} 项", { count: props.value.length })
    : options.find((option) => option.value === props.value)?.label ?? props.value;

  const choose = (option: ModelSelectOption) => {
    if (mode === "single") {
      props.onChange(option.value);
      close();
      return;
    }
    props.onChange(selected.has(option.value)
      ? props.value.filter((item) => item !== option.value)
      : [...props.value, option.value]);
  };

  const toggleGroup = (groupOptions: ModelSelectOption[], checked: boolean) => {
    if (mode !== "multiple") return;
    const groupValues = new Set(groupOptions.map((option) => option.value));
    props.onChange(checked
      ? [...props.value, ...groupOptions.filter((option) => !selected.has(option.value)).map((option) => option.value)]
      : props.value.filter((value) => !groupValues.has(value)));
  };

  const openMenu = () => {
    if (disabled) return;
    activate(orderedOptions.find(option => selected.has(option.value))?.value ?? orderedOptions[0]?.value ?? null);
    setOpen(true);
  };

  return <>
    <div ref={root} className={styles.target} data-open={open || undefined} data-disabled={disabled || undefined}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={t("筛选项：{label}，{summary}", { label, summary })}
        title={summary}
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => { if (open) close(); else openMenu(); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); openMenu(); } }}
      >
        <span>{label}</span><span className={styles.summary} aria-hidden="true">{summary}</span><Icon icon={chevronDownIcon} size="1.1em" />
      </button>
      {mode === "multiple" && props.value.length > 0 && <button
        type="button"
        className={styles.clear}
        aria-label={t("清除{label}筛选", { label })}
        onClick={() => props.onChange([])}
      ><Icon icon={windowCloseIcon} size="1.1em" /></button>}
    </div>
    {open && createPortal(<div
      id={menuId}
      ref={menu}
      tabIndex={0}
      role="listbox"
      aria-multiselectable={mode === "multiple" ? "true" : undefined}
      aria-activedescendant={activeValue === null ? undefined : `${menuId}-${activeValue}`}
      className={styles.menu}
      aria-label={label}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); navigate(event.key); }
        else if ((event.key === "Enter" || event.key === " ") && (event.target === menu.current || (event.target as HTMLElement).getAttribute("role") === "option")) {
          const option = orderedOptions.find(option => option.value === active.current);
          if (option) { event.preventDefault(); choose(option); }
        }
      }}
    >
      <div
        className={styles.listFrame}
        style={{ height: Math.min(items.length * 32, Math.max(32, position.maxHeight - (mode === "multiple" ? 45 : 0))) }}
      ><VirtualList
          items={items}
          itemKey="key"
          className={styles.list}
          style={{ height: "100%" }}
          estimatedItemHeight={32}
          overscan={4}
          onReady={(api) => { listApi.current = api; }}
          empty={<div className={styles.empty}>{t("暂无选项")}</div>}
        >{(item) => item.kind === "group"
          ? mode === "multiple"
            ? <GroupCheckbox
                label={item.label}
                options={item.options}
                selected={selected}
                onChange={(checked) => toggleGroup(item.options, checked)}
              />
            : <div className={styles.groupLabel}>{item.label}</div>
          : <label
              className={styles.optionRow}
              id={`${menuId}-${item.option.value}`}
              data-value={item.option.value}
              data-active={activeValue === item.option.value || undefined}
              role="option"
              aria-selected={selected.has(item.option.value)}
              tabIndex={-1}
              onPointerDown={() => activate(item.option.value)}
            >
              <input
                type="checkbox"
                checked={selected.has(item.option.value)}
                tabIndex={-1}
                onChange={() => choose(item.option)}
              />
              <span className={styles.checkbox} aria-hidden="true">
                {selected.has(item.option.value) && <Icon icon={checkIcon} size="0.875em" />}
              </span>
              <span className={styles.option}>
                {(item.option.icon || item.option.iconSrc) && <Icon icon={item.option.icon} src={item.option.iconSrc} />}
                <span>{item.option.label}</span>
              </span>
            </label>}</VirtualList></div>
      {mode === "multiple" && options.length > 0 && <div className={styles.footer}>
        <button type="button" onClick={() => props.onChange(options.map((option) => option.value))}>{t("全选")}</button>
        <button type="button" onClick={() => props.onChange([])}>{t("全不选")}</button>
      </div>}
    </div>, document.body)}
  </>;
}
