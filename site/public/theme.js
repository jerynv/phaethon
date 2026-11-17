// The app's dark theme is a `.dark` class (src/web/src/index.css); follow the system's choice.
const dark = matchMedia("(prefers-color-scheme: dark)");
const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
apply();
dark.addEventListener("change", apply);
