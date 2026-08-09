1. **untested** — 方法: `sed` で `RUNBOOK.md` の先頭見出しを取得。実行環境の起動時に `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` となり、コマンド未実行。

2. **untested** — 方法: `curl https://api.github.com`。同じ起動エラーにより、HTTPリクエスト未送信。

3. **untested** — 方法: `curl https://api.github.com/repos/bachikoljunior-blip/note`。同じ起動エラーにより、HTTPリクエスト未送信。

4. **untested** — 方法: `/tmp/codex_capability_probe_20260809.txt` に1行書き、`head` で読み返す。同じ起動エラーにより、書き込み未実行。

CAPABILITY read_cwd=untested network=untested other_repo=untested write=untested
