#!/usr/bin/env bash
# One-time setup for the Claude usage monitor, runnable from a phone browser
# inside a GitHub Codespace. Nothing here writes the token to disk or to a log.

set -uo pipefail

REPO="bachikoljunior-blip/-chatgpt-usage-monitorPrivate"
SECRET_NAME="CLAUDE_CODE_OAUTH_TOKEN"
SECRET_URL="https://github.com/${REPO}/settings/secrets/actions/new?name=${SECRET_NAME}"

echo
echo "================================================================"
echo " Claude サブスク使用量モニタ － 初回設定（1回だけ）"
echo "================================================================"
echo

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code を入れています（1〜2分）..."
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || {
    echo "インストールに失敗しました。手動で:  npm install -g @anthropic-ai/claude-code"
    exit 1
  }
fi

echo "【1】これから認証画面のURLが出ます。"
echo "     タップして承認 → 出てきたコードをこの画面に貼り戻してください。"
echo "     最後に sk-ant-oat01-... で始まる長い1行が表示されます。"
echo
read -r -p "     準備ができたら Enter を押してください… " _

claude setup-token
echo

echo "【2】いま表示された sk-ant-oat01-... の1行をコピーして、下に貼ってください。"
echo "     （入力は画面に表示されません。貼ったら Enter）"
echo
read -r -s -p "     token: " TOKEN
echo
echo

if [ -z "${TOKEN}" ]; then
  echo "何も入力されませんでした。中止します。"
  echo "あとから手で登録する場合はこちら: ${SECRET_URL}"
  exit 1
fi

case "${TOKEN}" in
  sk-ant-*) ;;
  *)
    echo "警告: sk-ant- で始まっていません。貼り間違いかもしれませんが、このまま登録を試みます。"
    ;;
esac

echo "【3】GitHub のシークレットに登録しています…"
if command -v gh >/dev/null 2>&1 && printf '%s' "${TOKEN}" | gh secret set "${SECRET_NAME}" --repo "${REPO}" 2>/dev/null; then
  unset TOKEN
  echo
  echo "  完了しました。設定はこれで終わりです。"
  echo "  すぐ結果を見たい場合は Actions で Claude usage monitor を Run workflow:"
  echo "  https://github.com/${REPO}/actions/workflows/claude-usage-monitor.yml"
  echo
  echo "  この Codespace はもう削除して構いません。"
  exit 0
fi

unset TOKEN
echo
echo "  自動登録はできませんでした（gh の権限不足です）。手で貼ってください:"
echo
echo "  ${SECRET_URL}"
echo
echo "  Name は入力済みで開きます。Secret 欄にさっきの sk-ant-oat01-... を貼って"
echo "  Add secret を押せば完了です。"
echo
exit 1
