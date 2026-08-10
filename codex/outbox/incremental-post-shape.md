# r/incremental_games 投稿形状調査

調査日: 2026-08-11（日本時間）

## 調査範囲と確認方法

- `r/incremental_games` の上位ページと、新着100件の JSON を実際に開いて確認した。
- 上位ページの取得結果は5日前、新着JSONの取得結果は2週間前にクロールされた内容だった。
- Reddit の個別投稿ページは直接開こうとしたが、3件とも開けなかった。そのため、個別ページが2026-08-11現在も直接表示できるかは未確認。下記の「削除されていない」は、取得できた新着JSONで `removed_by_category: null` かつ `is_robot_indexable: true` だったことを指す。
- 投稿もコメントもしていない。

## AI disclosure の実物

新着100件の取得結果で、AI disclosure があり、削除フラグが付いていない投稿を3件確認した。

### 1. Aethyr Idle

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v5dha7/
- 投稿日: 2026-07-24 14:46:49 UTC
- 見出しの正確な書き方: `AI Disclosure :`
- 位置: 本文末尾
- 節本文（元のMarkdownのまま）:

```
*AI Disclosure : G*enerative AI was used in development. It was used for some of the game's visual/graphic assets (artwork and placeholder art), and as a coding and writing assistant (help with parts of the code and some in-game text).
All game design, balancing, and final decisions are my own.
```

### 2. Pocket Universe, Inc.

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v4flfn/i_made_pocket_universe_inc_a_free_browser/
- 投稿日: 2026-07-23 14:30:36 UTC
- 見出しの正確な書き方: `AI Disclosure`（太字、コロンなし）
- 位置: 本文末尾
- 節本文（元のMarkdownのまま）:

```
**AI Disclosure**

Generative AI was used to assist with code, text, and artwork. All AI-assisted material was reviewed and edited before inclusion.
```

### 3. Idle Space Program

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v4adrp/idle_space_program_solo_dev_looking_for_feedback/
- 投稿日: 2026-07-23 10:49:25 UTC
- 見出しの正確な書き方: `AI disclosure:`（disclosure の d は小文字、コロン直結）
- 位置: 本文末尾
- 節本文（原文のまま）:

```
AI disclosure: Game icon and some graphics elements was prepared by AI and then edited by me in Aseprite.
```

## itch.io を出した投稿

「現在の作品またはプレイ先として itch.io を示している投稿」を対象にした。Steam が主対象で、過去作の説明にだけ itch.io が出る投稿は除外した。新しい順に最大5件。

### 1. The Infinite Library

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v5h4gh/the_infinite_library_demo_is_now_on_steam_and_07/
- 投稿日: 2026-07-24 16:58:08 UTC
- upvote: 非表示（JSONの `ups` は0、`hide_score` は true）
- paid/free: 分からない。本文には browser version / demo とあるが、価格の明記は確認できなかった。
- deleted?: 取得したJSONでは削除フラグなし。2026-08-11現在の個別ページは未確認。
- 先頭3行（空行を除く、原文）:

```
https://i.redd.it/5srxfbqfk7fh1.gif
Ten weeks ago I posted my first demo here (narrative incremental, you write words, fill shelves, and reality buckles). The response built this game's entire direction. This week two things happened at once:
**1. The demo is now on Steam** as a proper desktop install: [https://store.steampowered.com/app/4957060/The_Infinite_Library_Demo/](https://store.steampowered.com/app/4957060/The_Infinite_Library_Demo/)
```

### 2. Pocket Universe, Inc.

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v4flfn/i_made_pocket_universe_inc_a_free_browser/
- 投稿日: 2026-07-23 14:30:36 UTC
- upvote: 0
- paid/free: 無料。本文に「always be free」「no paywalls」と明記。
- deleted?: 取得したJSONでは削除フラグなし。2026-08-11現在の個別ページは未確認。
- 先頭3行（空行を除く、原文）:

```
https://preview.redd.it/u0sedc1150fh1.png?width=1280&format=png&auto=webp&s=38a6c7dfea2db8ec9b874b28245f871e21a0d304
Hey! I've been working on Pocket Universe, Inc. and it's finally at the point where I'm comfortable putting it in front of other incremental players.
You start by making a single unit of Matter at the Reality Core.
```

### 3. Yield & Yeast

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v44ox6/
- 投稿日: 2026-07-23 05:33:29 UTC
- upvote: 0
- paid/free: 分からない。本文には public playtest build とあるが、価格の明記は確認できなかった。
- deleted?: 取得したJSONでは削除フラグなし。2026-08-11現在の個別ページは未確認。
- 先頭3行（空行を除く、原文）:

```
Hey folks,
I've been working on a browser-based incremental game called **Yield & Yeast** and just uploaded the first public playtest build to itch.io.
**Play here:** [https://yieldandyeast.itch.io/yield-yeast](https://yieldandyeast.itch.io/yield-yeast)
```

### 4. Slime Reborn

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v3m0az/i_just_released_my_incremental_game_where_you/
- 投稿日: 2026-07-22 16:58:27 UTC
- upvote: 0
- paid/free: 分からない。本文には Early Access とあるが、価格の明記は確認できなかった。
- deleted?: 取得したJSONでは削除フラグなし。2026-08-11現在の個別ページは未確認。
- 先頭3行（空行を除く、原文）:

```
Hi everyone!
I've been working on **Slime Reborn**, a pixel-art incremental game where you start as a tiny slime and gradually evolve by unlocking new abilities, gathering resources, discovering hidden combos, and mutating into a more powerful creature.
I just released the **first public Early Access version**, and I'd love to hear what incremental game fans think.
```

### 5. Loot Goblins

- 投稿URL: https://www.reddit.com/r/incremental_games/comments/1v3gk44/a_3_months_later_update_on_loot_goblins/
- 投稿日: 2026-07-22 13:42:41 UTC
- upvote: 22
- paid/free: 分からない。本文では Demo とされているが、価格の明記は確認できなかった。
- deleted?: 取得したJSONでは削除フラグなし。2026-08-11現在の個別ページは未確認。
- 先頭3行（空行を除く、原文）:

```
The super original title returns.
A little over 3 months ago I was thinking of stopping the incremental game I was working on, I was trying to mix the bits I liked most from management/idle games.
I had made a post here and to my surprise 100s of people played it and gave it a go and gave great feedback on the game ([https://www.reddit.com/r/incremental_games/comments/1si0iio/early_game_feedback_for_loot_goblins_a_super/](https://www.reddit.com/r/incremental_games/comments/1si0iio/early_game_feedback_for_loot_goblins_a_super/)) which gave me the motivation to keep going despite kinda knowing just based on the style and the slew of crap in the space that it's not going to get back a fraction of what I put into it.
```

## 題名の形

開けた上位ページで、雑談・質問・定期スレを除き、自作物を紹介している投稿を上から順に10件抜き出した。題名は原文のまま。

1. `Two months ago, I showed you my game, World's Greatest Author. I just released it and included all your ideas! Except the hats.`
2. `Defrag Incremental is out now! Thanks for helping shape what it became :D`
3. `I made an incremental gambling game that runs inside a fake pixel-art OS [Demo on Itch]`
4. `Just released the demo of SCP Idle: SECURE. CONTAIN. PROGRESS.`
5. `Just launched the demo for Pinfinity - Incremental Pinball!`
6. `BudMageddon — every prestige moves your farm to a new planet with its own modifiers and art. 15 sectors, and the game actually ends. (free demo on Steam)`
7. `Incremental Birds is released!`
8. `ShredDead - an incremental tower defense with no fail state, where any zombie that gets through is shredded`
9. `Idle Underworlds : Shorter content, stable player base, future ideas`
10. `Rivet Nova — a browser-based incremental machine-building MMO is now in alpha. Looking for honest feedback`

## 判定

1. AI disclosure の実物: **3件**。
2. itch.io を現在の作品・プレイ先として出した投稿: **5件**。本文で有料と確認できたものは **0件**（無料1件、価格が分からない4件）。
3. 上位10件のうち、ゲーム本体ではなく creation kit / asset を出しているもの: **0件**。

## 出典

開けたURL:

- https://www.reddit.com/r/incremental_games/
- https://www.reddit.com/r/incremental_games/new.json?limit=100

個別ページとして開こうとしたが開けなかったURL（項目自体は上記JSONで確認）:

- https://www.reddit.com/r/incremental_games/comments/1v5dha7/ — open failed
- https://www.reddit.com/r/incremental_games/comments/1v4adrp/ — open failed
- https://www.reddit.com/r/incremental_games/comments/1v02zvk/ — open failed
