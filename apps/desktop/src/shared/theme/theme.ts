export const themeIds = ["default-dark", "default-light", "system"] as const;
export type ThemeId = (typeof themeIds)[number];

export const themeOptions = [
  { id: "default-dark" },
  { id: "default-light" },
  { id: "system" },
] satisfies { id: ThemeId }[];

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && themeIds.some((id) => id === value);
}

/** "system" 跟随操作系统深浅色;其余档位原样应用。 */
export function resolveTheme(themeId: ThemeId): "default-dark" | "default-light" {
  if (themeId !== "system") return themeId;
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "default-light"
    : "default-dark";
}

export function applyTheme(themeId: ThemeId) {
  document.documentElement.dataset.theme = resolveTheme(themeId);
}
