//! Reads resolved theme colors and motion preferences for canvas charts, including cached pages.
import { useEffect, useState } from "react";

function appearance() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    foreground: color("--vscode-foreground"),
    secondary: color("--vscode-descriptionForeground"),
    surface: color("--vscode-editorHoverWidget-background"),
    border: color("--vscode-editorHoverWidget-border"),
    grid: color("--vscode-sideBar-border"),
    input: color("--oa-chart-input"),
    cacheRead: color("--oa-chart-cache-read"),
    cacheWrite: color("--oa-chart-cache-write"),
    output: color("--oa-chart-output"),
    track: color("--oa-chart-track"),
    calendar: [0, 1, 2, 3, 4].map(level => color(`--oa-calendar-${level}`)),
  };
}

export function useChartAppearance() {
  const [value, setValue] = useState(appearance);
  useEffect(() => {
    const update = () => setValue(appearance());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", update);
    return () => { observer.disconnect(); motion.removeEventListener("change", update); };
  }, []);
  return value;
}
