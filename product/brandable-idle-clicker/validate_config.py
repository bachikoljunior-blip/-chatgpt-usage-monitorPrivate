#!/usr/bin/env python3
"""brand.config.json を検査します。

    python3 validate_config.py                 # brand.config.json を見る
    python3 validate_config.py examples/cafe.json

エラーがあれば、どこをどう直せばよいかを日本語で出します。
追加のインストールは要りません（Python 3 だけ）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EFFECTS = {"tapMultiplier", "rateMultiplier", "offlineMultiplier"}
COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def check(config: dict) -> list[str]:
    errors: list[str] = []

    def need(path: str):
        cur = config
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                errors.append(f"必須項目がありません: {path}")
                return None
            cur = cur[part]
        return cur

    need("meta.title")
    need("currency.name")
    tap = need("tapTarget.baseValue")
    if tap is not None and not (isinstance(tap, (int, float)) and tap > 0):
        errors.append("tapTarget.baseValue は正の数にしてください")

    for key, value in (config.get("theme") or {}).items():
        if key == "cornerRadius":
            if not isinstance(value, (int, float)) or value < 0:
                errors.append("theme.cornerRadius は0以上の数にしてください")
        elif not (isinstance(value, str) and COLOR.match(value)):
            errors.append(f"theme.{key} は #rrggbb 形式にしてください（いまの値: {value!r}）")

    generators = config.get("generators")
    if not isinstance(generators, list) or not generators:
        errors.append("generators を1つ以上書いてください")
        generators = []

    upgrades = config.get("upgrades") or []
    if not isinstance(upgrades, list):
        errors.append("upgrades は配列にしてください")
        upgrades = []

    seen: set[str] = set()
    for item in list(generators) + list(upgrades):
        if not isinstance(item, dict):
            errors.append(f"項目がオブジェクトではありません: {item!r}")
            continue
        item_id = item.get("id")
        if not item_id:
            errors.append(f"id がありません: {json.dumps(item, ensure_ascii=False)[:60]}")
        elif item_id in seen:
            errors.append(f"id が重複しています: {item_id}")
        else:
            seen.add(item_id)
        if not item.get("name"):
            errors.append(f"{item_id}: name を書いてください")

    for g in generators:
        if not isinstance(g, dict):
            continue
        for field in ("baseCost", "baseRate"):
            value = g.get(field)
            if not (isinstance(value, (int, float)) and value > 0):
                errors.append(f"{g.get('id')}: {field} は正の数にしてください")

    for u in upgrades:
        if not isinstance(u, dict):
            continue
        cost = u.get("cost")
        if not (isinstance(cost, (int, float)) and cost > 0):
            errors.append(f"{u.get('id')}: cost は正の数にしてください")
        effect = u.get("effect") or {}
        if effect.get("type") not in EFFECTS:
            errors.append(
                f"{u.get('id')}: effect.type は " + " / ".join(sorted(EFFECTS)) + " のいずれかです"
            )
        value = effect.get("value")
        if not (isinstance(value, (int, float)) and value > 0):
            errors.append(f"{u.get('id')}: effect.value は正の数にしてください")

    costs = [g.get("baseCost") for g in generators if isinstance(g.get("baseCost"), (int, float))]
    if costs != sorted(costs):
        errors.append("generators は baseCost の安い順に並べてください（並んでいないと画面に出る順番が入れ替わります）")

    prestige = config.get("prestige") or {}
    if prestige.get("enabled"):
        if not (isinstance(prestige.get("unlockAt"), (int, float)) and prestige["unlockAt"] > 0):
            errors.append("prestige.unlockAt は正の数にしてください")
        if not (isinstance(prestige.get("bonusPerPoint"), (int, float)) and prestige["bonusPerPoint"] > 0):
            errors.append("prestige.bonusPerPoint は正の数にしてください")
        if not prestige.get("currencyName"):
            errors.append("prestige.currencyName を書いてください")

    cta = config.get("cta") or {}
    if cta.get("enabled"):
        url = cta.get("url") or ""
        if not url.startswith(("https://", "http://")):
            errors.append("cta.url は https:// で始まるURLにしてください（使わないなら cta.enabled を false に）")
        elif "example.com" in url:
            errors.append("cta.url が example.com のままです。自社のURLに変えてください")

    milestones = config.get("milestones") or []
    ats = [m.get("at") for m in milestones if isinstance(m, dict)]
    if ats != sorted(a for a in ats if isinstance(a, (int, float))):
        errors.append("milestones は at の小さい順に並べてください")

    return errors


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "brand.config.json"
    if not target.is_file():
        print(f"ファイルが見つかりません: {target}")
        return 1
    try:
        config = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"JSON として読めません: {target}\n  {exc.lineno}行目: {exc.msg}")
        print("  よくある原因: 末尾のカンマ、閉じ忘れの括弧、全角のクォート")
        return 1

    errors = check(config)
    if errors:
        print(f"{target.name}: {len(errors)}件の問題が見つかりました\n")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"{target.name}: 問題ありません。そのまま公開できます。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
