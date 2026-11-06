export const themes = ['modern-dark', 'classic-light', 'pastel-diary'] as const;
export type Theme = typeof themes[number];
export const themeLabels: Record<Theme, string> = {
  'modern-dark': 'Modern Dark',
  'classic-light': 'Classic ERP Light',
  'pastel-diary': 'Pastel Diary Book',
};
