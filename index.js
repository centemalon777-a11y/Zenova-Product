const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getStorage } = require("firebase-admin/storage");

initializeApp();

const CHAPTERS = require("./data/chapters.json");
const CAST = require("./data/cast.json");
const QUIZZES = require("./data/quizzes.json");

const LIMITS = { free: 1, scholar: 5, master: 12 };

// Single source of truth for "what plan is this user actually entitled to right now".
// Treats an expired paid plan as free even if the database hasn't been reset yet —
// closes the timing gap where a stale 'master' value could linger after expiry.
async function getEntitlement(uid) {
  const db = getDatabase();
  const snap = await db.ref("users/" + uid).get();
  const data = snap.val() || {};
  let plan = data.plan || "free";
  const expiry = data.planExpiry ? new Date(data.planExpiry) : null;
  if (plan !== "free" && expiry && expiry < new Date()) {
    plan = "free";
  }
  return { plan, limit: LIMITS[plan] || 1 };
}

// Set this with: firebase functions:secrets:set FLW_SECRET_KEY
// Paste your Flutterwave SECRET key when prompted (starts with FLWSECK-).
// Never put the secret key in client-side code — only here.
const FLW_SECRET_KEY = defineSecret("FLW_SECRET_KEY");

// Source of truth for pricing — must match plans.html exactly.
// Client-sent amounts are never trusted; this is what we check against.
const PLAN_PRICES = {
  scholar: { monthly: 500, annual: 4200 },
  master: { monthly: 1000, annual: 8400 },
};

exports.verifyAndActivatePlan = onCall(
  { secrets: [FLW_SECRET_KEY], region: "us-central1" },
  async (request) => {
    // 1. Must be a signed-in user
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must be signed in to upgrade.");
    }

    const { transaction_id, planKey, billing } = request.data || {};

    if (!transaction_id || !planKey || !billing) {
      throw new HttpsError("invalid-argument", "Missing transaction_id, planKey, or billing.");
    }

    if (!PLAN_PRICES[planKey] || !PLAN_PRICES[planKey][billing]) {
      throw new HttpsError("invalid-argument", "Unknown plan or billing cycle.");
    }

    const expectedAmount = PLAN_PRICES[planKey][billing];
    const db = getDatabase();

    // 2. Stop the same transaction being used twice (replay protection)
    const usedRef = db.ref("usedTransactions/" + transaction_id);
    const usedSnap = await usedRef.get();
    if (usedSnap.exists()) {
      throw new HttpsError("already-exists", "This transaction has already been used.");
    }

    // 3. Ask Flutterwave directly — this is the step that can't be faked from a browser
    const verifyRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY.value()}` } }
    );

    if (!verifyRes.ok) {
      throw new HttpsError("internal", "Could not reach Flutterwave to verify payment.");
    }

    const verifyData = await verifyRes.json();
    const tx = verifyData.data;

    if (verifyData.status !== "success" || !tx || tx.status !== "successful") {
      throw new HttpsError("failed-precondition", "Payment was not successful.");
    }

    // 4. Confirm currency and amount actually match the plan they claim to have bought
    //    (stops someone paying ₦100 and claiming the ₦1000 plan)
    if (tx.currency !== "NGN" || tx.amount < expectedAmount) {
      throw new HttpsError("failed-precondition", "Payment amount or currency does not match the selected plan.");
    }

    // 5. Lock this transaction so it can't be replayed
    await usedRef.set({
      uid,
      planKey,
      billing,
      amount: tx.amount,
      verifiedAt: new Date().toISOString(),
    });

    // 6. Activate the plan — Admin SDK bypasses database rules, so this is the
    //    only place plan/planExpiry can legitimately be written.
    const now = new Date();
    const expiry = new Date(now);
    if (billing === "annual") {
      expiry.setFullYear(expiry.getFullYear() + 1);
    } else {
      expiry.setMonth(expiry.getMonth() + 1);
    }

    await db.ref("users/" + uid).update({
      plan: planKey,
      planBilling: billing,
      planStartDate: now.toISOString(),
      planExpiry: expiry.toISOString(),
      planUpdatedAt: now.toISOString(),
    });

    return { success: true, plan: planKey, expiry: expiry.toISOString() };
  }
);

// Returns chapter summaries, cast bios, and quiz questions — but only the
// content the user's CURRENT (server-verified) plan actually entitles them to.
// Locked items come back as bare stubs (title/sub only) so the dashboard can
// still render the "locked" cards without ever shipping the paid content.
exports.getDashboardContent = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const { plan, limit } = await getEntitlement(uid);

  const chapters = CHAPTERS.map((ch, i) => {
    if (i < limit) {
      const { audio, ...rest } = ch; // audio is fetched separately via getAudioUrl
      return rest;
    }
    return { num: ch.num, title: ch.title, sub: ch.sub };
  });

  const cast = CAST.map((c) => {
    if (c.ch <= limit) return c;
    return { ch: c.ch, emoji: c.emoji }; // emoji is shown even on locked cards
  });

  const quizUnlockCount =
    plan === "master" ? QUIZZES.length : plan === "scholar" ? 4 : 2;

  const quizzes = QUIZZES.map((q, i) => {
    if (i < quizUnlockCount) return q;
    return { title: q.title, sub: q.sub, emoji: q.emoji, diff: q.diff, cls: q.cls, ch: q.ch };
  });

  return { plan, limit, chapters, cast, quizzes };
});

// Issues a short-lived signed URL for one chapter's audio file — only if the
// caller's current plan actually covers that chapter. Audio files must live
// in a PRIVATE Storage bucket path (audio/<filename>.mp3), not public hosting,
// or this gate is pointless since the static file would still be guessable.
exports.getAudioUrl = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const { chapterIndex } = request.data || {};
  if (
    typeof chapterIndex !== "number" ||
    chapterIndex < 0 ||
    chapterIndex >= CHAPTERS.length
  ) {
    throw new HttpsError("invalid-argument", "Invalid chapter index.");
  }

  const { limit } = await getEntitlement(uid);
  if (chapterIndex >= limit) {
    throw new HttpsError("permission-denied", "Upgrade your plan to access this chapter's audio.");
  }

  const filename = CHAPTERS[chapterIndex].audio; // e.g. "11.mp3"
  const bucket = getStorage().bucket();
  const file = bucket.file("audio/" + filename);

  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes — long enough to play, short enough not to be worth sharing
  });

  return { url };
});
