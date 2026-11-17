# phaethon.app

Three React pages built from the app's own components, tokens and fonts (`@/` is
`src/web/src`), prerendered at build time and hydrated in the browser:

- `/` (`src/pages/home.tsx`): the hero, with a small WebGL shader (`src/shader.ts`) in
  the app's blue behind the app's window.
- `/download` (`src/pages/download.tsx`): every installer by platform, and how to
  run or build it from source.
- `/status` (`src/pages/status.tsx`): the latest release and build, recent changes
  on main with their CI result, releases and the roadmap.

`src/routes.tsx` lists the pages; each has its own HTML file at the site root
(`index.html`, `download.html`, `status.html`), which the build fills in.

- `pnpm site:dev`: local server with reload.
- `pnpm site:build`: `site/dist`. The build reads recent releases, CI runs and
  commits from GitHub and renders them into the HTML; the pages refresh them in
  the browser, so a new release shows up without a redeploy.
- `pnpm site:deploy`: build, then publish to Cloudflare (`wrangler.jsonc`: a
  static-assets Worker on phaethon.app and www.phaethon.app). Needs `wrangler login`.
- `pnpm site:shots`: regenerate the app screenshots from the real app (`pnpm build`
  first; needs `cwebp`). `scripts/og.mjs` makes the social preview from a running build (`vite preview`).
