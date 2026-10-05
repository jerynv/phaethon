/**
 * Applies the user's appearance before the first render: theme and token
 * overrides. For now it follows the system light/dark setting live; the
 * `.dark` class (shadcn convention) leaves room for an explicit choice.
 */
export function initAppearance(): void {
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
  apply();
  darkQuery.addEventListener("change", apply);
}
