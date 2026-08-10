#!/usr/bin/env node

// The loop whose subject is the thing being sold.
//
// Owner, 2026-08-10: 提供するものは測定分析改善ループまわさないと需要のあるものに
// なっていかない — what we offer will not become something anyone wants unless it
// goes through a measure / analyse / improve loop of its own.
//
// It was missing, and the shape of the omission is exact. This repository runs
// loops on the ROUTE: ETA, venue readiness, findable surface, reach, usage,
// heartbeats. Every one of them measures how the offer gets to a person. Not one
// of them takes the offer itself as its subject. state/portfolio.json has carried
// a field literally named `not_examined` since it was written, and on 2026-08-09
// the owner said, unprompted, 中身見てないんだけどこれ絶対売れないと思うよ. Both
// parties who could have judged the product declined to, and the listing, the
// cover, the tags, the category, the venue survey and the announcement were all
// built on top of it anyway.
//
// THE FIRST THING THIS LOOP FOUND IS THAT ITS SUBJECT DOES NOT EXIST.
//
// state/constraints.json the_product_itself_has_never_been_opened records the
// attempt: the four artifacts the live listing promises (brand.config.json,
// generator.html, validate_config.py, test_engine.py) are in no repository this
// account owns, established by four GitHub code searches plus a positive control
// that proves the index reaches private repositories. A built ZIP plausibly
// exists as a Gumroad attachment. No source tree does.
//
// So the offer cannot be measured, cannot be analysed, cannot be improved, and
// cannot be rebuilt if a buyer says it is broken. It is not that the loop has not
// been run on it. The loop CANNOT be run on it. That is the owner's sentence
// arriving from the other direction, and it is the whole reason this file exists
// rather than a round-runner: before you can loop on what you offer, what you
// offer has to be loopable, and nothing anywhere was checking that.
//
//   node scripts/product-loop.mjs           # report
//   node scripts/product-loop.mjs --check   # exit 1 on the four failures below
//
// The four:
//   1. an offer is live to buyers while `loopable` is false — measurement is
//      impossible, so no amount of surface work can be judged
//   2. a loopable offer whose newest round is older than MAX_ROUND_AGE_DAYS
//   3. a round that records a change with no re-measurement — "improved" on the
//      strength of having edited something
//   4. three consecutive rounds that moved nothing with no approach change
//
// 4 is the rule the note repository's IMPROVEMENT_LOOP already states and nothing
// enforced: three no-move rounds means change the approach, not the parameter.

import { readState, readStateJson } from "./state-source.mjs";

export const STATE_PATH = "state/product-loop.json";
export const MAX_ROUND_AGE_DAYS = 14;
export const NO_MOVE_LIMIT = 3;

/**
 * Did the reviewer actually exercise the artifact in this round?
 *
 * stranger_reaction is the elected route's prerequisite, and its task DECLARES
 * 払わない as the verdict to return unless a number overturns it. So a reviewer
 * who opens the page and stops has returned the default, not judged the product.
 * Round 1 (2026-08-10) recorded exactly that — engagement.played_or_read 読んだ,
 * "opened the page, looked at the opening screen, stopped there" — and wrote at
 * length about how much less it carries than a refusal after real play.
 *
 * Nothing read the field. To this file the round was a completed measurement
 * with a verdict, indistinguishable from twenty minutes of play ending in no.
 * That is the failure RUNBOOK 8 names: the file half was written carefully and
 * the machine half was never built, so the care survives exactly as long as the
 * session that wrote it.
 *
 * Two places it mattered. The rung reads as measured when what happened is that
 * a default came back; and rule 4 below would let three unengaged rounds demand
 * an approach change, which is a decision taken on three non-measurements.
 *
 * Tri-state on purpose. `null` is "this round does not say", which is not the
 * same as "the reviewer did not engage" and must not silently become it — older
 * rounds predate the field, and a check that reads absence as a verdict would
 * convict them of something nobody asked.
 *
 * @param {object} round
 * @returns {boolean|null}
 */
export function roundEngaged(round) {
  const e = round?.engagement;
  if (!e || typeof e !== "object") return null;

  // A number of minutes is the least ambiguous evidence available, and it is
  // checked first so a round carrying both is decided by the measurement rather
  // than by the word.
  const minutes = Number(e.minutes);
  if (Number.isFinite(minutes) && minutes > 0) return true;

  const said = String(e.played_or_read ?? "").trim();
  if (!said) return null;
  // 遊んだ / played means the artifact was exercised. 読んだ / read means the page
  // was looked at. The distinction is the reviewer's own word, quoted rather
  // than inferred, for the same reason the venue rules are quoted.
  if (/遊ん|played|plaid/i.test(said)) return true;
  if (/読ん|read|looked/i.test(said)) return false;
  return null;
}

/**
 * Can the round's claim of play be told apart from a careful read?
 *
 * roundEngaged() reads the reviewer's own word. That was the whole instrument,
 * and RUNBOOK 3 forbids exactly it: 自己申告を測定として扱わない。小さくても現物を
 * 1つ出させて、届いたかどうかで判定してください。
 *
 * 2026-08-10 task .m was written to close that gap and did not. It demanded three
 * numbers "you cannot write without playing": how many taps, the name and price of
 * the first thing bought, and the per-second rate before and after. The answer came
 * back 15 / 小さな衛星 15粒 / 0 → 0.2, and all three are correct — and all three are
 * in the artifact the reviewer was pointed at. assets/free-demo/index.html line 91
 * RENDERS 小さな衛星まで 15 on the opening screen before any input, and line 106 is
 * `{ name: '小さな衛星', baseCost: 15, perSecond: 0.2 }`. The proof-of-play question
 * was answerable by reading the file.
 *
 * That is not a flaw in one task. The artifact is a single self-contained HTML file
 * with its logic inline, so EVERY fact about it is in the text the reviewer opens.
 * No question of the form "tell me a number from the game" can distinguish playing
 * from reading, for this artifact or any other of its class. Evidence that separates
 * them has to come from outside the file — what the reviewer RAN, not what the
 * artifact SAYS.
 *
 * So the rule is mechanical and it is checked against the artifact rather than
 * against the reviewer: quote the evidence in `engagement.evidence`, and if every
 * quoted item appears verbatim in the artifact's own source, the claim is not
 * supported and the round does not count toward rounds_engaged.
 *
 * Tri-state. `null` is "cannot tell" — no evidence quoted, or no source to check
 * against — and it does NOT downgrade, for the same reason roundEngaged's null does
 * not: rounds predate the field.
 *
 * Substring matching over-reports readability: a short token like "15" matches
 * `Math.pow(1.15` too. That bias is deliberate and it is the safe direction, the
 * same one RUNBOOK 2 takes with unmeasurable laps — refusing to credit a
 * measurement costs a repeat, crediting a false one costs every decision downstream.
 *
 * @param {object} round
 * @param {string|null|undefined} artifactSource
 * @returns {boolean|null} true = at least one item is not in the source
 */
export function engagementSupported(round, artifactSource) {
  const e = round?.engagement;
  if (!e || typeof e !== "object") return null;
  // A transcript is evidence about the RUN by construction, so it does not need
  // the quote-against-source test — but it has to survive its own. See
  // transcriptIsSelfConsistent.
  // `unusable` returns false, not null. Null means "rounds predate this field and
  // silence is not a denial"; a transcript that is PRESENT and cannot be checked is
  // a claim nobody can verify, and RUNBOOK 2's direction applies — refusing to
  // credit a measurement costs a repeat, crediting a false one costs every decision
  // downstream. The reason is reported separately so the printed line is true.
  if (e.transcript) return transcriptIsSelfConsistent(e.transcript).verdict === "consistent";
  const quoted = (Array.isArray(e.evidence) ? e.evidence : [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);
  if (!quoted.length) return null;
  const src = String(artifactSource ?? "");
  if (!src) return null;
  return quoted.some((item) => !src.includes(item));
}

/**
 * Labels a program prints. ALL-CAPS tokens at the start of an output line —
 * CREATE, NAVIGATE, GECKO_EXIT, AMOUNT_SCRIPT_STATUS. That is the convention a
 * driver script falls into unprompted, and it is the only part of a transcript
 * that can be checked against the program without running either.
 */
const LABEL = /^\s*([A-Z][A-Z0-9_]{2,})\b/;

/**
 * Does a transcript's output match the program pasted beside it?
 *
 * WHY THIS EXISTS, and it is a measurement rather than a worry. Task 2026-08-10.p
 * established that the Codex lane HAS browsers and can drive one — chromium and
 * firefox found by `which`, a FATAL sandbox abort then a working --no-sandbox run
 * rendering a title, a geckodriver session that clicked twenty times and read the
 * DOM. That refuted the diagnosis two handoffs were built on. But its transcript
 * prints a line labelled AMOUNT_EL_TEXT_STATUS, and the program it pastes never
 * prints that label. So the program shown is not the program run.
 *
 * The innocent reading — an edited-down paste after iterating — is the likely one.
 * It is also indistinguishable from the other one, and "indistinguishable" is the
 * whole problem this rung has had since it was declared. A round whose evidence
 * cannot be told from a fabrication is not evidence, however probably honest.
 *
 * WHAT IT CANNOT DO, stated here rather than discovered later. A transcript that
 * prints no ALL-CAPS labels at all passes nothing and fails nothing — there is
 * simply nothing to cross-check — so that case returns `unusable` and is reported,
 * never folded into `consistent`. A vacuous pass reads as a measurement, and this
 * repository has already paid for one of those.
 *
 * @param {{program?: string, output?: string}|null|undefined} t
 * @returns {{verdict: "consistent"|"mismatched"|"unusable", labels: string[], unmatched: string[], why: string}}
 */
export function transcriptIsSelfConsistent(t) {
  const program = String(t?.program ?? "");
  const output = String(t?.output ?? "");
  if (!program.trim() || !output.trim()) {
    return { verdict: "unusable", labels: [], unmatched: [], why: "the transcript is missing its program or its output; one half proves nothing about the other" };
  }
  const labels = [...new Set(
    output.split("\n").map((line) => line.match(LABEL)?.[1]).filter(Boolean),
  )];
  if (!labels.length) {
    return { verdict: "unusable", labels: [], unmatched: [], why: "the output prints no labels, so there is nothing in it that the program can be checked against" };
  }
  const unmatched = labels.filter((l) => !program.includes(l));
  return unmatched.length
    ? {
        verdict: "mismatched",
        labels,
        unmatched,
        why: `the output prints ${unmatched.join(", ")}, which the pasted program never prints — so the program shown is not the program run`,
      }
    : { verdict: "consistent", labels, unmatched: [], why: `all ${labels.length} printed label(s) appear in the program` };
}

/**
 * Did the reviewer recognise the artifact?
 *
 * state/product-loop.json has carried the rule since the rung was declared: "A
 * round that comes back recognised is VOID and must be discarded rather than
 * kept." It was prose. Nothing read it.
 *
 * 2026-08-10, round 2 (codex/outbox/2026-08-10.f.md) came back 見覚え: ある. It is
 * also the best round this offer has ever had — the reviewer followed all five
 * steps, exchanged two items, reported 25 taps, named the exact moment the loop
 * became interesting and the exact moment it became boring, and gave a specific
 * reason for 払わない. Round 1 was criticised for being none of that.
 *
 * It is void anyway, and this function exists so that is not a judgement call
 * made by whichever lap happens to want the data. The rule is on the ANSWER, not
 * on the cause: a reviewer who recognises the page is not a stranger, whatever
 * made them recognise it.
 *
 * Tri-state for the same reason as roundEngaged: absent is null, because rounds
 * predate the field and silence is not a denial.
 *
 * @param {object} round
 * @returns {boolean|null}
 */
export function roundRecognised(round) {
  const said = String(round?.recognised ?? round?.engagement?.recognised ?? "").trim();
  if (!said) return null;
  // たぶんある counts as recognised: the rule names both, and a maybe-blind round
  // cannot be told apart from a broken one afterwards.
  if (/^(ある|たぶんある|yes|maybe)/i.test(said)) return true;
  if (/^(ない|no)/i.test(said)) return false;
  return null;
}

/**
 * Did the artifact's author review it?
 *
 * roundRecognised() catches the reviewer who SAYS it recognises the artifact.
 * This catches the case that produced those answers in the first place, and it
 * catches it before the answer comes back rather than after.
 *
 * 2026-08-10 settled which of the two competing explanations was right. Three
 * readings, and they only make one shape together:
 *
 *   author + played        → ある / たぶんある   (rounds 2 and 3, both void)
 *   non-author + played    → ない               (2026-08-10.i, a third-party game)
 *   non-author + code-read → ない               (2026-08-10.k and .l, opposite pairings)
 *
 * Engagement was the hypothesis on the table — that a reviewer who actually
 * exercises the mechanics recognises them, whoever wrote it. The control refutes
 * it: the lane played a game it had not written, in the same depth, and did not
 * recognise it. What survives is AUTHORSHIP, and authorship is a property of the
 * task rather than of the answer, so it can be enforced at the point the round is
 * recorded instead of discovered after a slot has been spent.
 *
 * That is the whole reason this exists as a separate rule. Recognition-after-the-
 * fact costs a lane slot per void round; this costs nothing and refuses the round
 * that was never going to be usable. scripts/lane-authorship.mjs enforces the
 * same rule on the OUTGOING task; this one enforces it on the round that comes
 * back, because a task can be paired correctly and still be filed under an offer
 * whose artifact a different model wrote.
 *
 * Tri-state, but absence is NOT a pass here — see rule 7 in judge(). Round 1
 * predates the field and was in fact self-reviewed; grandfathering it would have
 * kept the register's one counted round the one round the finding disqualifies.
 *
 * @param {object} round
 * @returns {boolean|null}
 */
export function roundSelfReviewed(round) {
  const p = round?.reviewer_pairing;
  if (!p || typeof p !== "object") return null;
  const reviewer = String(p.reviewer_model_key ?? "").trim();
  const author = String(p.author_model_key ?? "").trim();
  if (!reviewer || !author) return null;
  return reviewer === author;
}

/**
 * Does a stranger-round task text leak?
 *
 * The blind rule in state/product-loop.json is specific: "The task carries the
 * public URL and nothing else — no repository name, no authorship, no statement
 * of why it is being asked." Round 2's task opened with 前回この依頼を出したとき、
 * 返ってきたのは「初期画面を見て止めた」でした — it told the reviewer this page had
 * been reviewed before, in the course of explaining why the instructions were
 * stricter this time.
 *
 * So the blind was not broken by the lane being burned; it was broken by the
 * lap's urge to justify itself. That is worth catching mechanically because it
 * is the sympathetic kind of mistake: the sentence was added by a lap correctly
 * fixing round 1's weakness, and it reads as helpful context right up until it
 * costs the round.
 *
 * @param {string} text
 * @returns {string[]} the offending phrases, empty when clean
 */
/**
 * Whether a task section is one the blind applies to.
 *
 * This used to be an inline `/hoshikuzu|free-demo/` in tests/run-tests.mjs, which
 * scoped by the ARTIFACT'S NAME rather than by what the task is for — so the first
 * task that BUILT the demo rather than reviewing it was in scope too. It tripped no
 * pattern on the day, so nothing was red; the cost was latent. A build task is
 * naturally written by quoting the reviewer ("the previous version did X"), which
 * is exactly what blindLeaks matches, and the cheap way out of that red would have
 * been to weaken the patterns protecting the real rounds.
 *
 * It lives here rather than in the test because a rule spelled out inline in the
 * file that checks it cannot be mutation-tested: reverting it leaves the suite
 * green. As a function, breaking it fails.
 */
// What a task PRODUCES decides whether its blind is scanned. Both of these hand an
// artifact to someone and ask for a verdict, and in both the answer is void if the
// reviewer recognises what it is looking at.
//
// `review` was missing until 2026-08-10T07:4xZ, and it was missing for the two
// rounds this rung actually rests on. Tasks .k and .l — the pair that settled
// whether authorship or engagement drives recognition, and the only reason the lane
// is usable as a blind reviewer at all — are both produces: review, so the live
// scanner never looked at either. The register recorded that as a known gap on the
// day and named it "not fixed this lap"; then .q was filed under the same word and
// the gap covered a third round.
//
// It is the shape the file warns about twice over: a green check that is green
// because it is not looking, and a limitation written in prose beside a machine that
// cannot read prose. Scanning `review` costs nothing when the tasks are clean — .q
// is — and the whole value is that it goes red on the day one is not.
export const BLIND_SCOPED_KINDS = ["measurement", "review"];

export function inBlindScope(section) {
  const m = String(section ?? "").match(/^\s*produces\s*:\s*(.*)$/m);
  const produces = m ? m[1].replace(/\s*#.*$/, "").trim() : null;
  return BLIND_SCOPED_KINDS.includes(produces);
}

export function blindLeaks(text) {
  const s = String(text ?? "");
  // The owner's account name is INSIDE the artifact's own URL
  // (bachikoljunior-blip.github.io/O/hoshikuzu/), and the task cannot ask anyone
  // to open the page without it. So prose is scanned with URLs removed.
  //
  // This is a narrowing, not an exemption, and the residual is real: the blind
  // rule in state/product-loop.json says the task carries "no repository name",
  // while the URL it prescribes carries both the account name and the repo name
  // O. Round 1 came back 見覚え ない with that same URL, so the leak is weak — but
  // weak is not absent, and it is recorded as a known limitation of this blind
  // rather than deleted because it was inconvenient. A custom domain would remove
  // it; that is a real fix and nobody has priced it.
  const prose = s.replace(/https?:\/\/\S+/g, " ");
  const PATTERNS = [
    [/前回|前に(も)?(この|同じ)/, "refers to a previous round", prose],
    [/もう一度(この|同じ)|again this same/i, "says the reviewer is seeing it again", prose],
    [/初期画面を見て止め|opening screen and stopped/, "quotes the previous round's answer", prose],
    [/bachikoljunior|-chatgpt-usage-monitor|gumroad\.com/i, "names the owner's account or storefront outside the URL", prose],
    [/私たちが作|自分たちで作|we (built|made|wrote) (it|this)/i, "reveals authorship", prose],
  ];
  return PATTERNS.filter(([re, , where]) => re.test(where)).map(([, why]) => why);
}

// The measurement ladder, cheapest and fastest first. The ORDER is the design
// content, not decoration: each rung's signal returns sooner than the one below
// it, and a failure high up makes every lower reading uninterpretable. Measuring
// conversion on an artifact that does not deliver what its page promises tells
// you about the promise, not the product — and that is precisely the confusion
// the 8/23 judgement was heading for.
export const LADDER = [
  {
    id: "promise_conformance",
    needs: "the artifact's source, and the live listing text",
    question: "Does it deliver each thing the page claims? One verdict per claim.",
    why_first: "No traffic required, no waiting, and it is a contract rather than an opinion.",
  },
  {
    id: "stranger_reaction",
    needs: "the artifact, and a reviewer who did not make it",
    question: "Shown it cold, would someone pay for this? Default verdict: no.",
    why: "Costs one task on the Codex pool. The sibling repository has run this pattern for months; the rule that makes it work is that the critic is never the one who wrote the thing.",
  },
  {
    id: "sells_against",
    needs: "real listings with prices for the same buyer",
    question: "What do the things people actually buy have that this lacks?",
    why: "Delegable — this environment reaches almost nothing outside, and the lane reaches the open web.",
  },
  {
    id: "behaviour",
    needs: "traffic",
    question: "Views, then clicks, then purchases.",
    why_last: "The only decisive rung and the slowest. Reaching it first is how eight months produced ¥0 with nothing learned.",
  },
];

const DAY = 86_400_000;

/**
 * Loopability is DERIVED, never declared. An offer that could assert it would
 * assert it — that is what `not_examined` sitting unread for a week already
 * demonstrated.
 */
export function loopable(offer) {
  const reasons = [];
  if (!offer?.source || !offer.source.repo || !offer.source.path) {
    reasons.push("no source tree we own, so nothing can be changed or rebuilt");
  }
  if (!offer?.measurement?.rung) {
    reasons.push("no rung of the ladder is declared as its next measurement");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Was this round run by a REVIEWER, or by us?
 *
 * rounds_engaged is the number the elected route rests on, and its question is
 * whether someone who did not write the artifact would keep playing. When this lap
 * started driving the artifact in a browser, its round cleared engagementSupported()
 * honestly — timings are not quotable from source — and the count went to 1 on the
 * strength of the author's own hands. That is worse than the unreachable bar it
 * replaced: an unreachable bar leaves the number at 0 where anyone can see it, and
 * this would have moved it while nobody outside had touched the thing.
 *
 * So the two are separated. A round counts toward rounds_engaged only if it names a
 * reviewer. Rounds we ran ourselves count in rounds_played_here, which is a real
 * measurement and a different one.
 *
 * @param {object} round
 * @returns {boolean} true when someone other than this loop supplied the round
 */
export function roundHasReviewer(round) {
  if (!round || typeof round !== "object") return false;
  if (round.reviewer_pairing && typeof round.reviewer_pairing === "object") return true;
  return Boolean(round.task_id) && Boolean(round.answer);
}

/**
 * Has anyone RUN this offer, and what happened?
 *
 * engagementSupported() above proves a negative that went unstated for two rounds:
 * no question answerable in text can separate a reviewer who played from one who
 * read, because everything the artifact does is in the file the reviewer opens. The
 * Codex lane returns text. So rounds_engaged was unreachable by construction, and
 * every proof-of-play task queued at it was buying an impossibility.
 *
 * scripts/play-artifact.mjs is the other half: it drives the artifact in Chromium
 * and records timings and thrown runtime errors, which are facts about execution and
 * therefore not quotable from source. This reads what it wrote.
 *
 * Tri-state, same discipline as the rest of this file. `null` is "no run on record",
 * which is not "the artifact is fine" — an unplayed artifact and a clean one look
 * identical from here and must not be reported as the same thing.
 *
 * @param {string} offerId
 * @param {object|null} playDoc parsed state/play-measurements.json
 * @returns {{played: boolean|null, threw: boolean|null, measurement: object|null}}
 */
export function playedEvidenceFor(offerId, playDoc) {
  const m = playDoc?.artifacts?.[offerId] ?? null;
  if (!m || typeof m !== "object") return { played: null, threw: null, measurement: null };
  if (m.browser_available === false || m.run_failed || m.missing_file) {
    return { played: false, threw: null, measurement: m };
  }
  const errs = Array.isArray(m.page_errors) ? m.page_errors : null;
  const lat = Array.isArray(m.tap_latency_ms) ? m.tap_latency_ms.filter((n) => typeof n === "number") : [];
  return { played: lat.length > 0, threw: errs === null ? null : errs.length > 0, measurement: m };
}

/**
 * @param {{offers?: Array<any>}} doc
 * @param {{now: Date, artifactSources?: Record<string,string|null>, playMeasurements?: object|null}} ctx
 *   artifactSources maps offer id -> the artifact's own source text. Absent means
 *   "not available", which leaves engagement claims unchecked rather than refuted.
 *   playMeasurements is state/play-measurements.json, or null when nothing has run.
 */
export function judge(doc, { now, artifactSources = {}, playMeasurements = null, promiseConformance = null }) {
  const problems = [];
  const rows = [];

  // Rung 1's findings, surfaced HERE rather than only in their own script's exit
  // code. RUNBOOK 5.4: a check that is merely red is a report, and this project
  // has already proved reports do not steer it — the distribution class had a
  // working re-ranking and the laps went on picking build candidates. The place a
  // lap actually reads is this row set and the candidate list built from it, so a
  // failed promise on a PRICED product has to arrive there. `fails` only: partial
  // and blocked are findings a lap should read, not defects it must clear, and
  // folding them in would make the loudest row the one about our own toolchain.
  if (promiseConformance?.results) {
    const failed = promiseConformance.results.filter((r) => r.verdict === "fails");
    for (const r of failed) {
      problems.push(
        `${promiseConformance.offer_id} fails a promise its live listing makes — ${r.id}: ${r.observation}`,
      );
    }
  }

  for (const offer of doc?.offers ?? []) {
    const artifactSource = artifactSources[offer.id] ?? null;
    const play = playedEvidenceFor(offer.id, playMeasurements);
    const loop = loopable(offer);
    const rounds = Array.isArray(offer.rounds) ? offer.rounds : [];
    const newest = rounds.length ? rounds[rounds.length - 1] : null;
    // measured_at is this file's name for it; verified_at is what RUNBOOK 5.4
    // and every handoff tell a lap to write. Both were live at once, so the
    // first round ever completed (free_demo round 1, 2026-08-10) was written
    // with the documented name, carried a real verdict, and still reported
    // "has never completed a round" — the round was there and the reader was
    // looking at a different key. Accepting both is the cheap half; the reason
    // it is not just a rename is that older rounds may already carry either.
    const measuredAt = newest?.measured_at ?? newest?.verified_at ?? null;
    const ageDays = measuredAt
      ? Math.floor((now.getTime() - Date.parse(measuredAt)) / DAY)
      : null;

    // 1. Live to buyers and unmeasurable.
    if (offer.live_to_buyers && !loop.ok) {
      problems.push(
        `${offer.id} is live to buyers and cannot be measured: ${loop.reasons.join("; ")}. ` +
          "Every surface change made to it is unjudgeable, and a zero result will read as " +
          "the wrong venue when the cause may be the product.",
      );
    }

    // 2. Stale.
    if (loop.ok && (ageDays === null || ageDays > MAX_ROUND_AGE_DAYS)) {
      problems.push(
        ageDays === null
          ? `${offer.id} is loopable and has never completed a round — the loop exists on paper only`
          : `${offer.id}'s newest round is ${ageDays} days old (limit ${MAX_ROUND_AGE_DAYS})`,
      );
    }

    // 3. A change with no re-measurement. This is the failure that feels like
    //    progress: something was edited, so something must be better.
    for (const r of rounds) {
      if (r.changed && !r.verified_at) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} records a change ("${r.changed}") with no verified_at — ` +
            "re-measure the same way or the round taught nothing",
        );
      }
      if (r.changed && r.verified_at && r.moved === undefined) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} was re-measured but never says whether it moved`,
        );
      }
    }

    // 5. A verdict with no engagement recorded. Without it the rung cannot tell
    //    a refusal from a returned default, which is the whole content of the
    //    stranger_reaction rung.
    for (const r of rounds) {
      if (r.verdict && roundEngaged(r) === null) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} records verdict "${r.verdict}" but no engagement — ` +
            "say whether the reviewer exercised the artifact, or the round cannot be told from its default",
        );
      }
    }

    // 6. A recognised round sitting in `rounds` at all. The rule in
    //    state/product-loop.json is that such a round is VOID and discarded; a
    //    void round kept in the list would be counted by every rule above it.
    //    This fires on the register, not on the reviewer: the honest place for
    //    round 2 is void_rounds, where it is a record of an attempt rather than a
    //    measurement of a stranger.
    for (const r of rounds) {
      if (roundRecognised(r) === true) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} came back recognised (見覚え ある) and is still counted ` +
            "as a round. A reviewer who recognises the artifact is not a stranger — move it to " +
            "void_rounds. Keeping it because the content was good is the exact trade this rule exists to refuse",
        );
      }
    }

    // 7. The author judging its own artifact. Rule 6 fires on the ANSWER; this
    //    fires on WHO WAS ASKED, which is the cause rule 6 kept catching one
    //    round too late. A self-reviewed round is void for the same reason a
    //    recognised one is — the rung's entire content is that the critic is not
    //    the maker — and it is void even when the answer comes back ない, because
    //    an author who fails to recognise its own work has told us about its
    //    memory rather than about the product.
    //
    //    Absence is a problem rather than a pass, unlike roundEngaged's null. The
    //    difference is that engagement is a fact about a reviewer we may not have
    //    asked, while the pairing is a fact about a task WE wrote: if a round
    //    cannot say who reviewed it and who wrote the artifact, the answer is
    //    knowable and was not recorded.
    for (const r of rounds) {
      if (!r.verdict) continue;
      const self = roundSelfReviewed(r);
      if (self === true) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} was reviewed by the model that wrote the artifact ` +
            `(${r.reviewer_pairing?.reviewer_model_key}) and is still counted as a round. Move it to ` +
            "void_rounds: an author's verdict on its own work is not a stranger reaction, whatever it says",
        );
      } else if (self === null) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} records verdict "${r.verdict}" but no reviewer_pairing — ` +
            "name reviewer_model_key and author_model_key. Who was asked is a fact about our own task, " +
            "so leaving it out is not the same kind of silence as an unrecorded engagement",
        );
      }
    }

    // 8. A claim of play whose every piece of evidence is in the artifact's own
    //    source. Not a PROBLEM — the register is recording honestly when it quotes
    //    the evidence and lets this fire. The failure it prevents is silent: a
    //    later lap reading played_or_read 遊んだ and concluding the rung is
    //    measured. So it is counted and printed rather than made red.
    const engagedClaimedUnsupported = rounds.filter(
      (r) => roundEngaged(r) === true && engagementSupported(r, artifactSource) === false,
    ).length;

    // Of those, the ones rejected on their TRANSCRIPT rather than on quoting the
    // source. Same exclusion, different reason, and printing the wrong reason is
    // how a reader concludes the lane cannot run anything when in fact it ran
    // something and pasted the wrong program.
    const transcriptRejections = rounds
      .filter((r) => roundEngaged(r) === true && r?.engagement?.transcript)
      .map((r) => transcriptIsSelfConsistent(r.engagement.transcript))
      .filter((v) => v.verdict !== "consistent")
      .map((v) => v.why);

    // 4. Three no-move rounds without an approach change.
    let noMove = 0;
    for (const r of rounds) {
      if (r.approach_changed) noMove = 0;
      // A round the reviewer never engaged with cannot be evidence that a
      // parameter stopped working — nothing was tried. Round 1 argued this for
      // itself in prose (moved_note) and no reader enforced it; three such
      // rounds would have demanded an approach change on three non-measurements.
      else if (roundEngaged(r) === false) continue;
      else if (r.moved === false) noMove += 1;
      else if (r.moved === true) noMove = 0;
    }
    if (noMove >= NO_MOVE_LIMIT) {
      problems.push(
        `${offer.id} has ${noMove} consecutive rounds that moved nothing. The rule is change the ` +
          "approach, not the parameter — set approach_changed on the round that does it.",
      );
    }

    // 7. It throws while being played. Ranked as a problem rather than left in the
    //    row because a reviewer cannot report this: the two rounds on record read
    //    the source and neither mentioned that the rebuild calls an undefined
    //    render() at four sites. One tap shows it; a careful read did not.
    if (play.threw === true) {
      problems.push(
        `${offer.id} throws while being played: ${(play.measurement?.distinct_page_errors ?? []).join("; ")}. ` +
          "A verdict collected on an artifact that errors on interaction is a verdict about the error.",
      );
    }

    // 8. Loopable, and nobody has ever run it. Not the same as a clean run, and the
    //    distinction is the whole reason play-artifact.mjs exists — see
    //    playedEvidenceFor. Silence here would let a rung sit at engaged 0 forever
    //    while laps queue more text tasks at an evidence bar text cannot clear.
    //    Conditioned on the register existing. With no register at all the loop
    //    cannot tell "never run" from "no instrument", and reporting the first when
    //    it means the second would put a false finding in front of every lap. That
    //    the register must exist at all is asserted against the real file in
    //    tests/run-tests.mjs, not inferred here from its absence.
    if (playMeasurements && loop.ok && play.played !== true) {
      problems.push(
        `${offer.id} has never been RUN — ${play.played === false ? "the last attempt did not play it" : "no run is on record"}. ` +
          "Every round on it is a read. node scripts/play-artifact.mjs --write is the measurement.",
      );
    }

    rows.push({
      id: offer.id,
      live_to_buyers: Boolean(offer.live_to_buyers),
      loopable: loop.ok,
      why_not: loop.ok ? null : loop.reasons,
      next_rung: offer.measurement?.rung ?? null,
      rounds: rounds.length,
      // The count that means something for this rung. A rung whose only rounds
      // are unengaged has not been measured, however many rows it has. A claim of
      // play whose evidence is entirely readable from the artifact does not count:
      // it is a careful read that says 遊んだ, and this rung's question is whether
      // anyone would keep PLAYING.
      // Reviewers only. See roundHasReviewer — a round this loop ran with its own
      // hands is a measurement, but it is not a stranger, and this is the number the
      // elected route rests on.
      rounds_engaged: rounds.filter(
        (r) => roundHasReviewer(r) && roundEngaged(r) === true && engagementSupported(r, artifactSource) !== false,
      ).length,
      rounds_played_here: rounds.filter(
        (r) => !roundHasReviewer(r) && roundEngaged(r) === true && engagementSupported(r, artifactSource) !== false,
      ).length,
      rounds_engagement_claimed_unsupported: engagedClaimedUnsupported,
      rounds_rejected_on_transcript: transcriptRejections,
      newest_round_age_days: ageDays,
      consecutive_no_move: noMove,
      played_here: play.played,
      play_threw: play.threw,
      play_distinct_errors: play.measurement?.distinct_page_errors ?? null,
      play_tap_latency_ms: play.measurement?.tap_latency_ms ?? null,
    });
  }

  return { ok: problems.length === 0, problems, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { value: doc, via } = await readStateJson(STATE_PATH);
  if (!doc) {
    // Absent is not silent. The whole finding is that nothing had this file, and a
    // check that goes quiet when its subject is missing repeats it.
    console.error(`product loop: ${STATE_PATH} could not be read (${via})`);
    process.exit(1);
  }
  // The artifact each offer's engagement claims are checked against. Read the same
  // way state is read — from origin/main — because a claim checked against a stale
  // checkout is checked against a file the reviewer never saw.
  const artifactSources = {};
  for (const offer of doc.offers ?? []) {
    const path = offer?.source?.path;
    if (!path) continue;
    artifactSources[offer.id] = (await readState(path)).text;
  }

  // What happened when the artifact was RUN. Read from state the same way, so a
  // measurement that was taken but never pushed does not silently count.
  const { value: playMeasurements } = await readStateJson("state/play-measurements.json");

  // Rung 1's verdicts. Read from state like everything else, so a conformance run
  // that was taken but never pushed does not count as the rung having happened.
  const { value: promiseConformance } = await readStateJson("state/promise-conformance.json");

  const verdict = judge(doc, { now: new Date(), artifactSources, playMeasurements, promiseConformance });
  console.log(`product loop at ${new Date().toISOString()} (source: ${via})`);
  for (const r of verdict.rows) {
    console.log(
      `  ${r.id}: ${r.loopable ? "loopable" : "NOT LOOPABLE"} · live=${r.live_to_buyers} · ` +
        `rounds=${r.rounds} (engaged ${r.rounds_engaged}, played here ${r.rounds_played_here}) · next=${r.next_rung ?? "(none)"}`,
    );
    for (const why of r.why_not ?? []) console.log(`      ${why}`);
    // Printed for every offer, including the unplayed ones. An unplayed artifact and
    // a clean one must not look the same in the output a lap actually reads.
    {
      const lat = (r.play_tap_latency_ms ?? []).filter((n) => typeof n === "number");
      const median = lat.length ? lat.slice().sort((a, b) => a - b)[Math.floor(lat.length / 2)] : null;
      console.log(
        `      run: ${r.played_here === true ? "played" : r.played_here === false ? "NOT PLAYED" : "NEVER RUN"}` +
          (median === null ? "" : ` · tap feedback ${median}ms`) +
          (r.play_threw === true ? ` · THREW: ${(r.play_distinct_errors ?? []).join("; ")}` : "") +
          (r.play_threw === false ? " · no runtime errors" : ""),
      );
    }
    if (r.rounds_engagement_claimed_unsupported > 0) {
      console.log(
        `      ${r.rounds_engagement_claimed_unsupported} round(s) SAY 遊んだ and are not counted: every ` +
          "piece of evidence they quote is in the artifact's own source, so the claim cannot be told " +
          "from a careful read. Evidence that separates them has to be about what the reviewer RAN.",
      );
    }
    for (const why of r.rounds_rejected_on_transcript ?? []) {
      console.log(`      a round with a TRANSCRIPT is not counted: ${why}`);
    }
  }
  for (const p of verdict.problems) console.log(`  PROBLEM ${p}`);
  if (process.argv.includes("--check") && !verdict.ok) process.exit(1);
}
