#!/usr/bin/env python3
"""実際のブラウザで動くことを確かめます。

    python3 test_engine.py

見た目の確認ではなく、**動いた結果の数値**を読みます。
タップで増えるか、買ったら毎秒の値が増えるか、設定を差し替えたら色と文言が変わるか。
"""
from __future__ import annotations

import http.server
import json
import shutil
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from validate_config import check as check_config  # noqa: E402
FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


def serve(directory: Path) -> tuple[socketserver.TCPServer, int]:
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright が入っていません: pip install playwright")
        return 2

    work = ROOT / ".test-run"
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns(".test-run", "__pycache__"))

    httpd, port = serve(work)
    base = f"http://127.0.0.1:{port}/"
    default_cfg = json.loads((ROOT / "brand.config.json").read_text(encoding="utf-8"))

    try:
        with sync_playwright() as p:
            # 環境によっては playwright が想定するビルド番号と、置いてある Chromium が
            # 食い違う。既にあるものを使う（無ければ既定の解決に任せる）。
            candidates = sorted(Path("/opt/pw-browsers").glob("chromium-*/chrome-linux/chrome"))
            launch_args = {"executable_path": str(candidates[-1])} if candidates else {}
            browser = p.chromium.launch(**launch_args)
            page = browser.new_page(viewport={"width": 390, "height": 844})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

            page.goto(base, wait_until="networkidle")
            page.wait_for_selector("#app:not([hidden])", timeout=10000)

            check("起動する（#app が出る）", True)
            check("JavaScript エラーが無い", not errors, "; ".join(errors[:3]))
            check("タイトルが設定から来ている",
                  page.title() == default_cfg["meta"]["title"],
                  f"{page.title()!r}")

            accent = page.evaluate(
                "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
            check("テーマ色が設定から来ている",
                  accent.lower() == default_cfg["theme"]["accent"].lower(), f"--accent={accent}")

            def amount() -> float:
                return page.evaluate(
                    "() => { const t = document.getElementById('amount').textContent;"
                    " const m = t.match(/([0-9.]+)/); return m ? parseFloat(m[1]) : 0; }")

            before = amount()
            for _ in range(30):
                page.click("#tap")
            after = amount()
            check("タップで増える", after > before, f"{before} -> {after}")

            # 最初の画面に、まだ買えないものが並んでいないこと
            rows_at_start = page.eval_on_selector_all("#generators .row", "n => n.length")
            check("最初は選択肢を絞っている", rows_at_start <= 2, f"{rows_at_start}件")

            # 買えるまでタップしてから購入し、毎秒の値が0から動くことを見る
            for _ in range(400):
                page.click("#tap")
            page.wait_for_selector("#generators .row:not([disabled])", timeout=5000)
            page.click("#generators .row:not([disabled])")
            rate_text = page.inner_text("#rate")
            rate = float(rate_text.split("毎秒 ")[1].split("円")[0].replace(",", ""))
            check("買うと自動収入が発生する", rate > 0, rate_text)

            # 放置して自動収入が実際に加算されるか
            held = amount()
            page.wait_for_timeout(1500)
            check("放置で増える", amount() > held, f"{held} -> {amount()}")

            # 保存され、再読み込み後も残る
            reloaded_before = amount()
            page.reload(wait_until="networkidle")
            page.wait_for_selector("#app:not([hidden])", timeout=10000)
            check("再読み込みしても進行が残る", amount() >= reloaded_before * 0.5,
                  f"{reloaded_before} -> {amount()}")

            stacked = page.evaluate(
                "() => { const r = document.querySelector('#generators .row');"
                " if (!r) return null;"
                " const n = r.querySelector('.name').getBoundingClientRect();"
                " const d = r.querySelector('.desc').getBoundingClientRect();"
                " return d.top >= n.bottom - 1; }")
            check("行の名前と説明が別の行に出る", stacked is True, str(stacked))

            leaked = page.evaluate(
                "() => [...document.querySelectorAll('[hidden]')]"
                ".filter(n => n.getBoundingClientRect().height > 0).map(n => n.id)")
            check("hidden を付けた要素が画面に残らない", not leaked, str(leaked))

            page.screenshot(path=str(ROOT / "screenshot-default.png"))

            # 設定を差し替えるだけで別ブランドになること
            cafe = json.loads((ROOT / "examples" / "cafe.json").read_text(encoding="utf-8"))
            (work / "brand.config.json").write_text(
                json.dumps(cafe, ensure_ascii=False, indent=2), encoding="utf-8")
            page.goto(base, wait_until="networkidle")
            page.wait_for_selector("#app:not([hidden])", timeout=10000)
            new_accent = page.evaluate(
                "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
            check("設定の差し替えだけで題名が変わる",
                  page.title() == cafe["meta"]["title"], page.title())
            check("設定の差し替えだけで色が変わる",
                  new_accent.lower() == cafe["theme"]["accent"].lower(), new_accent)
            check("設定の差し替えだけで通貨名が変わる",
                  page.inner_text("#currency-name") == cafe["currency"]["name"], page.inner_text("#currency-name"))
            check("別ブランドの進行は混ざらない（保存キーが別）",
                  amount() == 0, f"{amount()}")
            page.screenshot(path=str(ROOT / "screenshot-cafe.png"))

            # 生成器が出す設定が、そのまま検査を通り、そのまま遊べること
            page.goto(base + "generator.html", wait_until="networkidle")
            page.fill("#title", "テスト商店 タップ経営")
            page.fill("#cur-name", "ポイント")
            page.click("#presets button:nth-child(3)")
            generated = json.loads(page.inner_text("#preview"))
            check("生成器が出す設定が検査を通る", not check_config(generated),
                  "; ".join(check_config(generated)))
            check("生成器の色が選んだ見本と一致する",
                  generated["theme"]["accent"].lower() == "#c79bff", generated["theme"]["accent"])
            (work / "brand.config.json").write_text(
                json.dumps(generated, ensure_ascii=False, indent=2), encoding="utf-8")
            page.goto(base, wait_until="networkidle")
            page.wait_for_selector("#app:not([hidden])", timeout=10000)
            check("生成器が出した設定で実際に起動する",
                  page.title() == "テスト商店 タップ経営", page.title())
            check("生成器が出した設定で通貨名が反映される",
                  page.inner_text("#currency-name") == "ポイント", page.inner_text("#currency-name"))

            # 壊れた設定はきちんと止まり、直し方が出ること
            (work / "brand.config.json").write_text('{"meta":{}}', encoding="utf-8")
            page.goto(base, wait_until="networkidle")
            page.wait_for_selector("#boot.error", timeout=10000)
            check("壊れた設定では止まって理由を出す",
                  "必須項目" in page.inner_text("#boot"), page.inner_text("#boot")[:60])

            browser.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(work, ignore_errors=True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)}件が失敗しました: " + ", ".join(FAILURES))
        return 1
    print("すべて通りました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
