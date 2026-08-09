# itch.io — Release Announcements post (English)

Read by `scripts/venue-readiness.mjs` as a member of the itch.io row's
`postable_when` in `state/constraints.json`. It is not decoration: the board's
own rule requires this text to exist before a post there is possible.

> Each topic should include: A link to the page on itch.io / A quick summary of
> the game / At least one embedded image or video

> Release posts that show little to no effort, or are just links, will be locked
> and removed.

Three requirements. The row checked one of them (`state/itch.json game_count`),
so the moment the pending owner request landed it would have read POSTABLE with
two of the venue's three stated requirements unmet.

**Why English.** `audience_language` on this row is `en`, measured. The Japanese
version of this post already exists inside
`state/owner-requests.json` → `2026-08-09.itch-page-for-the-kit` → `step_2`, and
it is the version that would have been pasted into an English-language board.
Nothing caught that, because `language_fit` derives the artifact's language from
`assets/free-demo/index.html` — which is the artifact for the **r/gamedev** row
and not for this one. It gave the right verdict here by coincidence: both files
happen to be Japanese.

**The image.** `assets/itch-cover.png`, already committed, 630x500, regenerate
with `node scripts/render-cover.mjs`. The same file uploaded as the project
cover is the one to embed here. Nothing has to be drawn or screenshotted.

**What the owner types: nothing.** The link below is fixed in advance from
`state/itch.json` `profile.username` plus the slug chosen in the same request
(`idle-clicker-kit`), so no URL is substituted after the page exists.

---

## Title

An idle-clicker kit you reskin by editing one config file (HTML/CSS/JS, commercial use OK)

## Body

I've released the kit I use as the starting point for idle clickers — the whole
base for shipping one as your own game.

The only file you edit is `brand.config.json`. Title, palette, the name of the
thing you're counting, 8 producers, 6 upgrades, milestone messages, the call-to-
action button and the footer all come from there. You get a different game
without touching the game logic.

The number balance is already tuned. Costs and per-second rates ship with
defaults that hold together, so it's playable the moment you've changed the
names and the colours. That's the part of an idle game that eats the most time.

No build step, no external libraries, no network calls — drop the folder
somewhere and it runs. Saves go to `localStorage`, so there's no server and no
database. Built for portrait phones: one hand, taps only. It runs as-is on
GitHub Pages, Netlify, Cloudflare Pages or your own host.

**What's in it**

- The game itself (HTML / CSS / JavaScript)
- `brand.config.json` — the only file you edit
- `generator.html` — fill in a form, get the config file back
- Three worked reskins (coffee shop, salon, streamer) showing how far config
  alone moves the look and the wording
- `validate_config.py` — checks your config and tells you what's wrong with it
- `test_engine.py` — 20 automated checks in a real browser
- README and licence

**Verified how:** 20 checks run in Chromium — boot, tap increments, buying a
producer starts passive income, idle accrual, progress surviving a reload,
swapping the config changing title/palette/currency name, and a broken config
stopping with a stated reason rather than failing silently. The test script
ships with the kit, so you can re-run the same checks after you've modified it.

**Licence (commercial use permitted).** Use it in your own game or on your own
site — one published destination, modification allowed. Delivering it as part of
client work: please ask first. What you can't do is resell or redistribute the
kit itself as an asset or template product.

**Two things to know before you buy.** There's no audio and there are no image
assets — everything on screen is emoji and CSS. And the README, the licence and
the config validator's messages are in Japanese; the code, the config keys and
this post are in English.

USD 25.

https://bachikoljunior-blip.itch.io/idle-clicker-kit

Happy to hear what you think — and a report that it didn't run for you is just
as useful.

---

## Not decided here

- **Whether posting to the board is itself an owner action.** `state/itch.json`
  proves API access (`itch.io/api/1/KEY/me` → 200), and
  `state/constraints.json itch_no_write_api` records that the server API is six
  read-only endpoints with no forum write. So `account.exists: true` on this row
  means "an account exists", not "a lap can post from it". Nobody has separated
  those two, and the row cannot currently say which it means.
- **Whether the product page body should also be English.** This file covers the
  announcement only. The page copy lives in
  `state/owner-requests.json` → `step_1` → `description_body_to_paste` and is
  Japanese. Changing it is a separate decision with a separate cost: the
  Japanese Gumroad listing is the one surface `scripts/sync-listing.mjs` and
  `tests/run-tests.mjs` already enforce, and forking it into two languages
  without a reader on both is how a correction reaches one surface and dies on
  the other.
