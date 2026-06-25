const admin = require('firebase-admin');

// Initialize Firebase Admin SDK once
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Fix private key newlines — Vercel sometimes mangles them when you paste JSON
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://zenova-4342f-default-rtdb.firebaseio.com'
    });
  } catch (e) {
    console.error('Firebase init failed:', e.message);
  }
}

const PLAN_PRICES = {
  scholar: { monthly: 500,  annual: 4200 },
  master:  { monthly: 1000, annual: 8400 },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transaction_id, planKey, billing, idToken } = req.body || {};

  // 1. Confirm the user is signed in
  if (!idToken) {
    return res.status(401).json({ error: 'NOT_LOGGED_IN' });
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'NOT_LOGGED_IN', detail: e.message });
  }

  // 2. Basic checks
  if (!transaction_id || !planKey || !billing) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }
  if (!PLAN_PRICES[planKey] || !PLAN_PRICES[planKey][billing]) {
    return res.status(400).json({ error: 'INVALID_PLAN' });
  }

  const db = admin.database();

  // 3. Replay protection — stop same transaction being used twice
  const usedRef = db.ref('usedTransactions/' + transaction_id);
  const usedSnap = await usedRef.get();
  if (usedSnap.exists()) {
    return res.status(409).json({ error: 'ALREADY_USED' });
  }

  // 4. Verify with Flutterwave directly
  let tx;
  try {
    const flwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    const flwData = await flwRes.json();
    tx = flwData.data;
    if (flwData.status !== 'success' || !tx || tx.status !== 'successful') {
      return res.status(402).json({ error: 'PAYMENT_NOT_SUCCESSFUL', detail: flwData.message });
    }
  } catch (e) {
    return res.status(500).json({ error: 'FLUTTERWAVE_UNREACHABLE', detail: e.message });
  }

  // 5. Confirm amount matches plan
  const expectedAmount = PLAN_PRICES[planKey][billing];
  if (tx.currency !== 'NGN' || tx.amount < expectedAmount) {
    return res.status(402).json({ error: 'AMOUNT_MISMATCH', paid: tx.amount, expected: expectedAmount });
  }

  // 6. Lock this transaction
  await usedRef.set({
    uid, planKey, billing,
    amount: tx.amount,
    verifiedAt: new Date().toISOString(),
  });

  // 7. Activate the plan — admin SDK bypasses database rules
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
