# Claude サブスクの使用量を自動で見えるようにする（あなたの作業は1回だけ）

ChatGPT/Codex 側はすでに自動で動いています。ここでは Claude サブスク側を同じ形にします。
**必要なのは「トークンを1個つくって、GitHub に貼る」だけです。所要 2 分、以降は不要です。**

---

## スマホしか無い場合はこちら（ブラウザだけで完結）

パソコンのターミナルが無くても、GitHub Codespaces のターミナルがスマホのブラウザで開けます。
無料枠の範囲で使えて、終わったら削除すれば残りません。

1. スマホのブラウザで開く →
   <https://github.com/codespaces/new?repo=bachikoljunior-blip/-chatgpt-usage-monitorPrivate>
   （**Create codespace** を押す。起動に1〜2分かかります）
2. 起動すると下側のターミナルで**設定スクリプトが自動で始まります**。
3. 表示された `https://claude.ai/oauth/authorize?...` を**長押しコピーして別タブで開く** → 承認
4. 画面に出たコードをコピーして、ターミナルの `code:` に**長押しでペースト** → Enter
5. スクリプトが使用量APIで動作確認し、そのまま GitHub のシークレットに登録します。
   権限不足で登録できなかったときだけ、表示されるリンクを開いて手で貼ってください。
6. 終わったら Codespace は削除してかまいません（<https://github.com/codespaces>）。

自動で始まらなかったときは、ターミナルにこれだけ打ってください。

```sh
node scripts/setup-claude-token.mjs
```

> **なぜ `claude setup-token` を使わないのか。** あのコマンドは認証コードを
> `http://localhost:<port>/callback` でしか受け取りません。スマホのブラウザから見た
> `localhost` はスマホ自身なので、Codespace の中で待っているサーバーには絶対に届かず、
> 「サーバに接続できませんでした」で必ず止まります。このスクリプトは同じ公式の OAuth
> クライアントを、**コードを画面に表示する方式**（`platform.claude.com/oauth/code/callback`）で
> 使うので、localhost が一切登場しません。

> このスクリプトはトークンをファイルにもログにも書きません。標準入力で `gh` に直接渡すので、
> `ps` にも履歴にも残りません。

以下はパソコンがある場合の手順です。

---

## 手順（2ステップ）

### 1. トークンを作る

自分のパソコンのターミナルで、次を実行します。

```sh
claude setup-token
```

ブラウザが開いて承認を求められるので、承認します。
ターミナルに `sk-ant-oat01-...` で始まる文字列が1行出るので、**それをコピー**します。

> `claude` コマンドが無い場合は先に `npm install -g @anthropic-ai/claude-code` を実行してください。

### 2. GitHub に貼る

次のリンクを開きます（名前は入力済みの状態で開きます）。

<https://github.com/bachikoljunior-blip/-chatgpt-usage-monitorPrivate/settings/secrets/actions/new?name=CLAUDE_CODE_OAUTH_TOKEN>

- **Name**: `CLAUDE_CODE_OAUTH_TOKEN`（すでに入っています）
- **Secret**: さっきコピーした文字列を貼り付け
- **Add secret** を押す

以上です。次の毎時22分の自動実行から使用量が入ります。すぐ見たい場合は
[Claude usage monitor のページ](https://github.com/bachikoljunior-blip/-chatgpt-usage-monitorPrivate/actions/workflows/claude-usage-monitor.yml)
で **Run workflow** を押すと即座に更新されます。

---

## 別のやり方（`claude setup-token` が使えないとき）

パソコンの `~/.claude/.credentials.json` の中身を**まるごと**同じシークレットに貼っても動きます。
収集スクリプトは JSON なら `claudeAiOauth.accessToken` を自分で取り出します。

---

## 結果の見かた

- 人が読む用: [`CLAUDE_USAGE.md`](CLAUDE_USAGE.md)
- 機械が読む用: [`state/claude-usage.json`](state/claude-usage.json)
- 両方まとめて1コマンド: `node scripts/show-usage.mjs`

```
Claude: ok · mode normal · 12 min old
  Current session: 87.5% left (resets 2026-08-08T04:00:00.000Z)
  Current week (all models): 19% left (resets 2026-08-12T00:00:00.000Z)
ChatGPT / Codex: ok · mode normal · 28 min old
  codex: 42% left (resets 2026-08-08T04:26:18.000Z)
```

`mode` は**残りが一番少ない枠**から決まります。`normal`（残り25%超）/ `conserve`（10〜25%）/
`reserve`（10%以下）。

---

## トークンの扱い

- トークンは GitHub の暗号化シークレットにだけ置かれます。リポジトリには入りません。
- コミットされるのは**％・リセット時刻・枠の長さだけ**です。
  `scripts/verify-sanitized-state.mjs` が毎回、資格情報らしきキーと値を検査して弾きます。
- トークンが失効すると `CLAUDE_USAGE.md` の状態が `reauthentication_required` になります。
  そのときだけ、手順1と2をもう一度やってください（1年程度は不要のはずです）。
- このリポジトリは private のままにしてください。

## うまくいかないとき

| `state/claude-usage.json` の `error.code` | 意味 | やること |
|---|---|---|
| `token_missing` | シークレット未設定 | 上の手順2 |
| `token_unreadable` | 貼った中身が壊れている | 貼り直す |
| `reauthentication_required` | 失効・取り消し済み | 手順1からやり直す |
| `usage_endpoint_unavailable` | 使用量APIが応答しない | 放置（次の実行で再試行） |
| `rate_limited` / `request_timeout` | 一時的な失敗 | 放置（次の実行で再試行） |

`/usage` のデータは Pro / Max / Team / Enterprise プランにだけ存在します。
API 従量課金だけのアカウントでは枠が返らず、表は空になります。
