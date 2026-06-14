const express  = require('express');
const admin    = require('firebase-admin');
const path     = require('path');

// ── Firebase Admin Init ──
const serviceAccount = process.env.FIREBASE_KEY
  ? JSON.parse(process.env.FIREBASE_KEY)
  : require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Change this to a strong password ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'GoalRush@Admin2024!';

app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// ── Simple auth middleware ──
function requireAuth(req, res, next){
  const token = req.headers['x-admin-token'];
  if(token === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if(password === ADMIN_PASSWORD){
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ════════════════════════════════════════
//  USERS
// ════════════════════════════════════════
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').get();
    const users = [];
    snap.forEach(d => users.push({ ...d.data(), uid: d.id }));
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:uid', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.params.uid).set(req.body, { merge: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:uid/fund', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const ref  = db.collection('users').doc(req.params.uid);
    const snap = await ref.get();
    if(!snap.exists) return res.status(404).json({ error: 'User not found' });
    const newBalance = Number(snap.data().balance || 0) + Number(amount);
    await ref.set({ balance: newBalance, lastFundedAt: new Date().toISOString() }, { merge: true });
    await db.collection('logs').add({ time: new Date().toISOString(), action: 'Funded ₦'+Number(amount).toLocaleString(), user: snap.data().phone || req.params.uid });
    res.json({ success: true, newBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:uid/disable', requireAuth, async (req, res) => {
  try {
    const { disabled } = req.body;
    await db.collection('users').doc(req.params.uid).set({ disabled, status: disabled ? 'disabled' : 'active' }, { merge: true });
    // Also disable in Firebase Auth
    await admin.auth().updateUser(req.params.uid, { disabled });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:uid/archive', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.params.uid).set({
      archived: true, archivedAt: new Date().toISOString(), status: 'archived'
    }, { merge: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:uid/restore', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.params.uid).set({
      archived: false, archivedAt: null, disabled: false, status: 'active'
    }, { merge: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  TICKETS
// ════════════════════════════════════════
app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('tickets').get();
    const tickets = [];
    snap.forEach(d => tickets.push(d.data()));
    tickets.sort((a,b) => (b.created||'').localeCompare(a.created||''));
    res.json(tickets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tickets', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('tickets').get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    await db.collection('logs').add({ time: new Date().toISOString(), action: 'All tickets cleared', user: 'admin' });
    res.json({ success: true, deleted: snap.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  DEPOSITS
// ════════════════════════════════════════
app.get('/api/deposits', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('deposits').get();
    const deps = [];
    snap.forEach(d => deps.push(d.data()));
    deps.sort((a,b) => (b.time||'').localeCompare(a.time||''));
    res.json(deps);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deposits/:id/approve', requireAuth, async (req, res) => {
  try {
    const depRef  = db.collection('deposits').doc(req.params.id);
    const depSnap = await depRef.get();
    if(!depSnap.exists) return res.status(404).json({ error: 'Deposit not found' });
    const dep = depSnap.data();
    // Credit user — find by phone
    const uSnap = await db.collection('users').where('phone','==',dep.user).get();
    let newBalance = 0;
    if(!uSnap.empty){
      const uRef  = uSnap.docs[0].ref;
      newBalance  = Number(uSnap.docs[0].data().balance||0) + Number(dep.amount||0);
      await uRef.set({ balance: newBalance, lastDeposit: new Date().toISOString() }, { merge: true });
    }
    await depRef.set({ status:'approved', approvedAt: new Date().toISOString() }, { merge: true });
    await db.collection('logs').add({ time: new Date().toISOString(), action: 'Deposit approved ₦'+Number(dep.amount).toLocaleString(), user: dep.user });
    res.json({ success: true, newBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deposits/:id/reject', requireAuth, async (req, res) => {
  try {
    await db.collection('deposits').doc(req.params.id).set({ status:'rejected' }, { merge: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  WITHDRAWALS
// ════════════════════════════════════════
app.get('/api/withdrawals', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('withdrawals').get();
    const wds = [];
    snap.forEach(d => wds.push(d.data()));
    wds.sort((a,b) => (b.time||'').localeCompare(a.time||''));
    res.json(wds);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdrawals/:id/paid', requireAuth, async (req, res) => {
  try {
    await db.collection('withdrawals').doc(req.params.id).set({ status:'paid', paidAt: new Date().toISOString() }, { merge: true });
    await db.collection('logs').add({ time: new Date().toISOString(), action: 'Withdrawal paid ref:'+req.params.id, user: '' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  APP SETTINGS (matches, prizes, etc.)
// ════════════════════════════════════════
app.get('/api/settings/:doc', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('app_settings').doc(req.params.doc).get();
    res.json(snap.exists ? snap.data() : {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/:doc', requireAuth, async (req, res) => {
  try {
    await db.collection('app_settings').doc(req.params.doc).set(req.body, { merge: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/:doc', requireAuth, async (req, res) => {
  try {
    await db.collection('app_settings').doc(req.params.doc).delete();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  PUBLISHED ROUNDS
// ════════════════════════════════════════
app.get('/api/published_rounds', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('published_rounds').get();
    const rounds = [];
    snap.forEach(d => rounds.push(d.data()));
    rounds.sort((a,b) => (a.savedAt||'').localeCompare(b.savedAt||''));
    res.json(rounds);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/published_rounds/:id', requireAuth, async (req, res) => {
  try {
    await db.collection('published_rounds').doc(req.params.id).set(req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
//  LOGS
// ════════════════════════════════════════
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('logs').orderBy('time','desc').limit(500).get();
    const logs = [];
    snap.forEach(d => logs.push(d.data()));
    res.json(logs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/logs', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('logs').get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Serve admin panel ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`✅ GoalRush Admin Server running on port ${PORT}`);
});
