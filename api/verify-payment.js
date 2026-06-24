const admin = require('firebase-admin');

// Initialize Firebase Admin SDK once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: 'https://zenova-4342f-default-rtdb.firebaseio.com'
  });
}

// Prices must match plans.html exactly.
// The browser never decides how much a plan costs — only this file does.
const PLAN_PRICES = {
  scholar: { monthly: 500,  annual: 4200 },
  master:  { monthly: 1000, annual: 8400 },
};

module.exports = async (req, res) => {
  // Allow the browser to call this function
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transaction_id, planKey, billing, idToken } = req.body || {};

  // 1. Confirm the user is actually signed in to Zenova
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  // 2. Basic input checks
  if (!transaction_id || !planKey || !billing) {
    return res.status(400).json({ error: 'Missing fields.' });
  }
  if (!PLAN_PRICES[planKey] || !PLAN_PRICES[planKey][billing]) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }

  const db = admin.database();

  // 3. Make sure this exact transaction hasn't been used before
  //    (stops someone reusing the same payment reference to upgrade twice)
  const usedRef = db.ref('usedTransactions/' + transaction_id);
  const usedSnap = await usedRef.get();
  if (usedSnap.exists()) {
    return res.status(409).json({ error: 'This payment has already been used.' });
  }

  // 4. Ask Flutterwave directly — did this transaction actually succeed?
  //    This is the step a browser can never fake, because it uses the secret key.
  let tx;
  try {
    const flwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    const flwData = await flwRes.json();
    tx = flwData.data;
    if (flwData.status !== 'success' || !tx || tx.status !== 'successful') {
      return res.status(402).json({ error: 'Payment was not successful.' });
    }
  } catch {
    return res.status(500).json({ error: 'Could not reach Flutterwave. Try again.' });
  }

  // 5. Confirm the amount paid actually matches the plan they're claiming
  //    (stops someone paying ₦500 and claiming a ₦1000 plan)
  const expectedAmount = PLAN_PRICES[planKey][billing];
  if (tx.currency !== 'NGN' || tx.amount < expectedAmount) {
    return res.status(402).json({ error: 'Payment amount does not match the selected plan.' });
  }

  // 6. Lock this transaction so it can never be reused
  await usedRef.set({
    uid, planKey, billing,
    amount: tx.amount,
    verifiedAt: new Date().toISOString(),
  });

  // 7. Activate the plan in Firebase — only THIS function can write plan data.
  //    The database rules (database.rules.json) block all browser writes to plan fields.
  const now = new Date();
  const expiry = new Date(now);
  if (billing === 'annual') {
    expiry.setFullYear(expiry.getFullYear() + 1);
  } else {
    expiry.setMonth(expiry.getMonth() + 1);
  }

  await db.ref('users/' + uid).update({
    plan: planKey,
    planBilling: billing,
    planStartDate: now.toISOString(),
    planExpiry: expiry.toISOString(),
    planUpdatedAt: now.toISOString(),
  });

  return res.status(200).json({
    success: true,
    plan: planKey,
    expiry: expiry.toISOString(),
  });
};
