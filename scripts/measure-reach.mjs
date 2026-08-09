#!/usr/bin/env node

// How many people does this account already reach, with nobody doing anything?
//
// Why this exists, and why it is a WRITER and not another reader.
//
// scripts/compute-eta.mjs has read state/external-metrics.json since the day it was
// written. Nothing has ever written that file. So the `if (!external)` branch fired
// on every single run, and every run emitted the same sentence:
//
//     "no external-metrics.json published yet; YouTube figures live in another repo
//      and are not readable here"
//
// The second half of that sentence is false, and it was load-bearing. The repo is
// bachikoljunior-blip/youtube, it is in the owner's OWN repo set, and a session
// reaches it with two calls (add_repo, then get_file_contents) — no owner action, no
// credential, no survey. It is absent from the session's initial Repository Scope
// list, which is the whole reason six sessions read "not readable here" and stopped.
//
// This repository already has a name for the shape: a reader with no writer, which
// check-wiring.mjs question C exists to catch. It did not catch this one, because the
// reader guards the absence with a fallback that reads like a finding instead of like
// a hole. A fallback that states a REASON for the missing data is worse than a crash:
// it answers the question nobody has checked.
//
// What the number is for. The elected distribution route is blocked on lift — every
// recorded near-success had a third party with reach, or breadth, or an audience that
// already existed. The first two were measured absent. The third was never measured
// at all, and it turns out to be roughly 1,200 views a day, running hourly, unattended.
//
// What the number is NOT for. Reach is not demand. This channel's audience and the
// priced product's buyer are different people, and the file says so where it is
// derived rather than in a comment. Nothing here claims a sale.
//
//   node scripts/measure-reach.mjs [--write] [--json]
//
// Exit 0 = a fresh scan snapshot exists and derives cleanly.
// Exit 1 = no snapshot, an unusable snapshot, or the snapshot has gone stale.

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO } from "./state-source.mjs";

// A snapshot older than this is refused rather than quietly reported. The sibling
// loop commits several times an hour; a week of silence means the branch moved, the
// loop stopped, or the provenance is wrong, and all three should go red rather than
// let a stale reach number keep electing a route.
export const MAX_SNAPSHOT_AGE_DAYS = 7;

// From the sibling repository's own docs/STRATEGY.md and JOURNAL.md: the YouTube
// Partner Programme gate is BOTH of these, and the slower one decides. Recorded as
// data because the derivation below divides by it; a reader who thinks the threshold
// changed should edit it here and see the days move.
export const YPP_GATE = { subscribers: 1000, watch_hours: 4000 };

/**
 * Pure so the tests can drive it without a repository.
 *
 * The window is derived from the DAY KEYS, never from `since`. YouTube Analytics
 * lags about two days, so a snapshot taken on the 9th with `since: 08-04` carries
 * four days of data and not six. Dividing 4,835 views by six days rather than four
 * understates the rate by a third, and the rate is the entire output of this file.
 */
export function deriveReach(snapshot) {
  const rec = snapshot?.record;
  const days = Object.keys(rec?.views_by_day ?? {}).sort();
  if (days.length < 2) {
    return {
      usable: false,
      why_not:
        "fewer than two dated days in the snapshot, so there is a level but no rate. " +
        "A level does not say whether the reach is growing, shrinking or one-off.",
      window_days: days.length,
    };
  }

  const t = rec.totals ?? {};
  const windowDays = days.length;
  const views = Number(t.views ?? 0);
  const engaged = Number(t.engagedViews ?? 0);
  const watchHours = Number(t.estimatedMinutesWatched ?? 0) / 60;
  const subsNet = Number(t.subscribersGained ?? 0) - Number(t.subscribersLost ?? 0);

  const viewsPerDay = views / windowDays;
  const engagedPerDay = engaged / windowDays;
  const watchHoursPerDay = watchHours / windowDays;
  const subsPerDay = subsNet / windowDays;

  // Days to the monetisation gate at the OBSERVED rate. Both halves are required, so
  // the answer is the slower one. Infinity where the rate is zero or negative — the
  // honest reading of "at this rate, never", and deliberately not null, because null
  // reads as "unmeasured" everywhere else in this repository.
  const daysToSubs = subsPerDay > 0 ? YPP_GATE.subscribers / subsPerDay : Infinity;
  const daysToHours = watchHoursPerDay > 0 ? YPP_GATE.watch_hours / watchHoursPerDay : Infinity;
  const daysToGate = Math.max(daysToSubs, daysToHours);

  return {
    usable: true,
    window_days: windowDays,
    window_first_day: days[0],
    window_last_day: days[days.length - 1],
    views,
    views_per_day: round(viewsPerDay),
    engaged_views_per_day: round(engagedPerDay),
    watch_hours: round(watchHours),
    watch_hours_per_day: round(watchHoursPerDay),
    subscribers_net: subsNet,
    subscribers_per_day: round(subsPerDay),
    subscriber_conversion: views > 0 ? Number((subsNet / views).toExponential(2)) : null,
    days_to_ypp_subscribers: finiteOrNull(daysToSubs),
    days_to_ypp_watch_hours: finiteOrNull(daysToHours),
    days_to_ypp_gate: finiteOrNull(daysToGate),
    ypp_gate_binding_half: daysToSubs >= daysToHours ? "subscribers" : "watch_hours",
  };
}

const round = (n) => Number(n.toFixed(2));
const finiteOrNull = (n) => (Number.isFinite(n) ? Number(n.toFixed(0)) : null);

/**
 * How a consumer of an external channel row must read its idle_eta_days.
 *
 * It lives here, exported, rather than inline in scripts/compute-eta.mjs, because
 * compute-eta does its work at import time and cannot be imported by a test. A copy
 * of this logic asserted in the suite would be a test of the copy — this repository's
 * most-repeated failure, and it would have passed while the real reader stayed broken.
 *
 * The bug being pinned: `Number(null)` is 0 and `Number.isFinite(0)` is true, so the
 * obvious coercion turns "no ETA" into "reaches ¥200,000/month today", and the
 * portfolio takes the MINIMUM, so a single null reported the whole goal as met. It
 * fired on the first run after a writer for state/external-metrics.json finally
 * existed. It had been unreachable for the reader's entire life BECAUSE nothing wrote
 * that file: the fallback branch was the only branch anyone ever executed.
 */
export const externalEta = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Reach that cannot be pointed at anything is a number, not a route — so the row the
 * ranking reads carries which of our two assets this surface will actually accept.
 *
 * Derived by re-running the sibling repo's own upload guard over our own URLs, rather
 * than by trusting the snapshot's prose about them. The guard is a plain substring
 * test over the title, description and first comment, so it is reproducible here
 * exactly; recording its VERDICT without re-deriving it would be an assertion in a
 * file whose whole point is that assertions were what went wrong.
 *
 * WHY THE FORBIDDEN HALF IS COMPUTED FIRST. r/gamedev's rule was quoted correctly six
 * sessions ago and read only for what it PERMITS, while the clause forbidding paid
 * promotion sat unread in the same sentence and cost the loop five laps. So this
 * surface's rule is read for what it forbids before anything is placed on it.
 */
export function addressabilityVerdict(snapshot) {
  const a = snapshot?.addressability;
  if (!a) return { known: false, why: "the snapshot carries no addressability block" };
  const words = a.the_rule_read_for_what_it_FORBIDS?.words ?? [];
  const hits = (url) => words.filter((w) => (url ?? "").includes(w));
  const paid = hits(a.the_rule_read_for_what_it_FORBIDS?.gumroad_url);
  const free = hits(a.the_rule_read_for_what_it_FORBIDS?.free_demo_url);
  return {
    known: true,
    surface: a.the_surface ?? null,
    paid_link_permitted: paid.length === 0,
    free_link_permitted: free.length === 0,
    free_link_forbidden_by: free,
    // Deliberately three-valued rather than a boolean. "Nobody has established it" and
    // "established as no" lead to different laps, and collapsing them is the mistake
    // account.exists made when it conflated 'an account exists' with 'a lap can post'.
    lap_may_perform_the_edit: a.lap_may_perform_the_edit ?? null,
    note: a.NOT_settled ?? null,
  };
}

export function addressabilitySentence(v) {
  if (!v?.known) return "ADDRESSABILITY UNKNOWN: nobody has established whether the reach can be pointed at anything, which is the difference between a route and a number.";
  const parts = [];
  parts.push(
    v.paid_link_permitted
      ? "The surface PERMITS the paid product's link"
      : "The surface FORBIDS the paid product's link",
  );
  parts.push(
    v.free_link_permitted
      ? "and permits the free demo's."
      : `and FORBIDS the free demo's (${v.free_link_forbidden_by.join(", ")}) — so route 1's entire payload cannot go here as hosted. That is the exact INVERSE of r/gamedev, which permits the free artifact and forbids being paid.`,
  );
  if (v.lap_may_perform_the_edit === null) {
    parts.push(
      "Whether a lap may perform the edit is NOT established — permission is not the question (A14), coordination with the sibling loop is.",
    );
  } else if (v.lap_may_perform_the_edit === false) {
    parts.push("A lap may NOT perform the edit; it is the sibling loop's act.");
  }
  return parts.join(" ");
}

/**
 * The channel row compute-eta.mjs consumes. Also pure, and separate from deriveReach
 * on purpose: the reach numbers are a measurement and the ETA verdict is a judgement
 * about them, and the second one is the part a later lap is most likely to argue with.
 *
 * idle_eta_days stays null here even though days_to_ypp_gate is a finite number, and
 * that is the honest answer rather than a missing feature. The gate is a threshold for
 * being PAID AT ALL, not the ¥200,000/month target, and the sibling loop's own estimate
 * of post-gate income is in the ¥1,000s per month. A channel that reaches four figures
 * a month after eleven years does not reach the target, so writing the gate distance
 * into idle_eta_days would make the loop's top-priority goal report success on a number
 * that is not the goal. That exact substitution — a condition that reads as achieved
 * while achieving nothing — is why unlocks_when exists in state/constraints.json.
 */
export function toChannelRow(snapshot, reach) {
  const base = {
    id: "youtube",
    measured_at: snapshot?.record?.at ?? null,
    monthly_yen_now: 0,
    owner_actions_required: 0,
    addressability: addressabilityVerdict(snapshot),
  };
  if (!reach.usable) {
    return { ...base, idle_eta_days: null, reason: `not derivable: ${reach.why_not}` };
  }
  return {
    ...base,
    idle_eta_days: null,
    reason:
      `measured, not unreadable: ${reach.views_per_day}/day views and ` +
      `${reach.engaged_views_per_day}/day engaged over ${reach.window_days} days ` +
      `(${reach.window_first_day}..${reach.window_last_day}), zero owner actions. ` +
      `Ad revenue is not the path — at this rate the YouTube Partner gate is ` +
      `${reach.days_to_ypp_gate} days away on ${reach.ypp_gate_binding_half}, and the sibling ` +
      `loop prices the far side of it in the ¥1,000s/month against a ¥200,000 target. ` +
      `What is worth the ranking's attention is the REACH, which the elected route was ` +
      `blocked on and which nothing here had counted. ` +
      addressabilitySentence(base.addressability),
    reach,
  };
}

// --- runner ----------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");
  const snapPath = resolve(REPO, "state/youtube-scan.json");

  if (!existsSync(snapPath)) {
    console.error(
      "state/youtube-scan.json is missing. A lap fetches it: add_repo bachikoljunior-blip/youtube, " +
        "then read the last record of data/scan.jsonl on the branch named in the previous snapshot's " +
        "provenance. A script cannot do it — Actions has no cross-repo token.",
    );
    process.exit(1);
  }

  const snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
  const ageDays = (Date.now() - Date.parse(snapshot.fetched_at)) / 86_400_000;
  const reach = deriveReach(snapshot);
  const row = toChannelRow(snapshot, reach);

  const out = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    note:
      "Derived by scripts/measure-reach.mjs from state/youtube-scan.json. Do not hand-edit: " +
      "the numbers here are a division of the snapshot, and editing them detaches the claim " +
      "from the commit that can contradict it.",
    source_snapshot: {
      fetched_at: snapshot.fetched_at,
      age_days: Number(ageDays.toFixed(2)),
      stale: ageDays > MAX_SNAPSHOT_AGE_DAYS,
      provenance: snapshot.provenance ?? null,
    },
    channels: [row],
  };

  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`reach snapshot: ${snapshot.fetched_at} (${ageDays.toFixed(2)}d old)`);
    if (!reach.usable) console.log(`  NOT DERIVABLE: ${reach.why_not}`);
    else {
      console.log(
        `  ${reach.views_per_day} views/day · ${reach.engaged_views_per_day} engaged/day · ` +
          `${reach.watch_hours_per_day} watch-hours/day over ${reach.window_days}d ` +
          `(${reach.window_first_day}..${reach.window_last_day})`,
      );
      console.log(
        `  subscribers ${reach.subscribers_net} net (${reach.subscribers_per_day}/day, ` +
          `conversion ${reach.subscriber_conversion}) — YPP gate ${reach.days_to_ypp_gate}d away, ` +
          `binding on ${reach.ypp_gate_binding_half}`,
      );
      console.log(
        "  THIS IS REACH, NOT DEMAND. The audience is Japanese consumers reading money-and-work " +
          "calculations; the priced product is a USD 25 developer kit. Reach is the term the " +
          "elected route was blocked on, and it is now a number instead of an assumption.",
      );
      console.log(`  ${addressabilitySentence(row.addressability)}`);
    }
  }

  if (write) {
    await writeFile(
      resolve(REPO, "state/external-metrics.json"),
      `${JSON.stringify(out, null, 2)}\n`,
      "utf8",
    );
    console.log("wrote state/external-metrics.json");
  }

  if (!reach.usable) process.exit(1);
  if (ageDays > MAX_SNAPSHOT_AGE_DAYS) {
    console.error(
      `snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_SNAPSHOT_AGE_DAYS}). Re-fetch it ` +
        "before letting the route election keep resting on it.",
    );
    process.exit(1);
  }
}
