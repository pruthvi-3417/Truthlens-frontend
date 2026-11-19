export type ThemePreference = 'dark' | 'light' | 'system';

export function applySavedTheme(): void {
  const saved = localStorage.getItem('truthlens-theme') as ThemePreference | null;
  const preference: ThemePreference = saved === 'light' || saved === 'system' ? saved : 'dark';
  const effective = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themePreference = preference;
}
