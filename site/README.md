# phaethon.app

The download and status page: one React page (`src/page.tsx`) built from the app's
own components, tokens and fonts (`@/` is `src/web/src`), prerendered at build time
and hydrated in the browser. The hero art is a small WebGL shader (`src/shader.ts`)
over the app's CSS mesh.

- `pnpm site:dev`: local server with reload.
- `pnpm site:build`: `site/dist`. The build reads the latest release, CI state and
  last commit from GitHub and renders them into the HTML; the page refreshes them in
  the browser, so a new release shows up without a redeploy.
- `pnpm site:deploy`: build, then publish to Cloudflare (`wrangler.jsonc`: a
  static-assets Worker on phaethon.app and www.phaethon.app). Needs `wrangler login`.
- `pnpm site:shots`: regenerate the app screenshots from the real app (`pnpm build`
  first; needs `cwebp`). `scripts/og.mjs` makes the social preview from a running build (`vite preview`).
