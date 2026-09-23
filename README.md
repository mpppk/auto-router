# auto-router

Capability-aware な OpenRouter 互換ルーター。設計は [#1](https://github.com/mpppk/auto-router/issues/1) を参照。

- Runtime: Cloudflare Workers
- HTTP framework: Hono
- Package manager / test runner: Bun
- Lint / format: Biome

## Development

```sh
bun install
bun run dev        # wrangler dev (http://localhost:8787)
```

| Script | 内容 |
| --- | --- |
| `bun run lint` / `lint:fix` | Biome による lint + format チェック / 自動修正 |
| `bun run typecheck` | `tsc` による型チェック (`src` と `test`) |
| `bun run test` | `bun test` |
| `bun run build` | `wrangler deploy --dry-run` でバンドルを検証 |
| `bun run cf-typegen` | `wrangler.jsonc` から `worker-configuration.d.ts` を再生成 |
| `bun run check:types` | `worker-configuration.d.ts` が最新か確認 |

`wrangler.jsonc` の bindings を変更したら `bun run cf-typegen` を実行し、生成された `worker-configuration.d.ts` もコミットしてください。

### Secrets

ローカルでは `.dev.vars` に、本番では `wrangler secret put <NAME>` で設定します。

- `JEV_API_KEY` — Jev semantic detector 用 (#3 以降で使用)

## CI/CD

`.github/workflows/ci.yml`

- PR / `main` への push: lint, 型チェック, テスト, バンドル検証
- `main` への push: 上記成功後に Cloudflare Workers へデプロイ (GitHub Environment `production`)

デプロイには以下の GitHub Secrets が必要です。

- `CLOUDFLARE_API_TOKEN` — "Edit Cloudflare Workers" テンプレートで作成した API Token
- `CLOUDFLARE_ACCOUNT_ID`
