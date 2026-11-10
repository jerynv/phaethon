// Applies the cached appearance before the first paint, so a dark or
// high-contrast window never flashes light. A plain (classic) script so it
// runs before the body is parsed. src/lib/appearance.ts owns the full logic and
// writes the cache this reads.
(function () {
  var root = document.documentElement;
  var a = {};
  try {
    a = JSON.parse(localStorage.getItem("phaethon.appearance.v1") || "{}") || {};
  } catch (e) {}
  var t = (a && typeof a.tokens === "object" && a.tokens) || {};
  var mq = function (q) {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  };
  var num = function (v, d) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  };
  var dark = a.theme === "dark" || (a.theme !== "light" && mq("(prefers-color-scheme: dark)"));
  if (dark) root.classList.add("dark");
  if (a.increaseContrast === "on" || (a.increaseContrast !== "off" && mq("(prefers-contrast: more)"))) root.setAttribute("data-contrast", "more");
  if (a.reduceMotion === "on" || (a.reduceMotion !== "off" && mq("(prefers-reduced-motion: reduce)"))) root.setAttribute("data-motion", "reduce");
  if (a.readingFont === "opendyslexic" || a.readingFont === "lexend" || a.readingFont === "system") root.setAttribute("data-font", a.readingFont);
  root.setAttribute("data-focus-rings", num(t["--ph-focus-rings"], 0) === 1 ? "on" : "off");
  if (num(t["--ph-target-size"], 24) > 24) root.setAttribute("data-targets", "large");
  root.style.setProperty("--ph-text-scale", String(Math.min(2, Math.max(1, num(t["--ph-text-scale"], 1)))));
  try {
    var hue = parseFloat(localStorage.getItem("phaethon.space-hue") || "");
    if (isFinite(hue)) root.style.setProperty("--space-hue", String(hue));
  } catch (e) {}
  var desktop = window.phaethonDesktop;
  if (desktop && desktop.platform) root.setAttribute("data-platform", desktop.platform);
})();
