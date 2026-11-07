# quota-icons

Vendored provider icons for the 订阅用量 (magpie quotas) page.

- Source: https://github.com/yetone/magpie — `internal/gui/assets/icons/*.svg`
- License: MIT (same as magpie). Keep this note when redistributing.
- Fetched: 2026-11-07, 177 files, whole set pulled on purpose so a newly
  connected provider already has its icon and no code change is needed.
- Naming: the `icon` field of `POST /v1/magpie/quotas/refresh` (and
  `GET /v1/magpie/quotas/cards`) maps 1:1 to `<icon>.svg` here.
  No match → the page falls back to a first-letter tile.

Refresh the set (GitHub needs the proxy on this machine):

```bash
export HTTPS_PROXY=http://127.0.0.1:15236 HTTP_PROXY=http://127.0.0.1:15236
gh api "repos/yetone/magpie/git/trees/main?recursive=1" --jq '.tree[].path' \
  | grep -E '^internal/gui/assets/icons/.*\.svg$' \
  | sed 's#internal/gui/assets/icons/##' \
  | xargs -P 8 -I{} curl -s -f -o {} \
      "https://raw.githubusercontent.com/yetone/magpie/main/internal/gui/assets/icons/{}"
```
