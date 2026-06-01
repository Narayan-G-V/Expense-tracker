/**
 * db.js — SpendWise Cloud Sync Service
 * Handles LocalStorage persistence + Firebase Firestore synchronization.
 * Falls back to LocalStorage when Firebase is not configured.
 */

const DB_KEY_TX       = 'spendwise_transactions';
const DB_KEY_BUDGETS  = 'spendwise_budgets';
const DB_KEY_CONFIG   = 'spendwise_firebase_config';
const DB_KEY_SYNC_Q   = 'spendwise_sync_queue';

/* ─── Internal State ──────────────────────────────────────────────────────── */
let _firebaseApp      = null;
let _firestoreDb      = null;
let _isFirebaseReady  = false;
let _isOfflineMode    = false;
let _isSyncing        = false;
let _lastSyncTime     = null;
let _listeners        = {};       // event callbacks: { status, sync, data }
let _unsubscribeRT    = null;     // Firestore real-time listener unsubscribe fn

/* ─── Event Bus ──────────────────────────────────────────────────────────── */
export function onDbEvent(event, callback) {
  _listeners[event] = _listeners[event] || [];
  _listeners[event].push(callback);
}

function emit(event, payload) {
  (_listeners[event] || []).forEach(fn => fn(payload));
}

/* ─── Status Helpers ─────────────────────────────────────────────────────── */
function setStatus(state, desc) {
  // state: 'local' | 'online' | 'offline' | 'syncing' | 'error'
  emit('status', { state, desc });
}

export function addSyncLog(msg, type = '') {
  emit('log', { msg, type });
}

/* ─── LocalStorage Helpers ───────────────────────────────────────────────── */
function lsGet(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('LocalStorage write failed:', e);
    return false;
  }
}

/* ─── Sync Queue (offline-first) ─────────────────────────────────────────── */
function getSyncQueue() { return lsGet(DB_KEY_SYNC_Q, []); }
function addToSyncQueue(op) {
  const q = getSyncQueue();
  q.push({ ...op, ts: Date.now() });
  lsSet(DB_KEY_SYNC_Q, q);
}
function clearSyncQueue() { lsSet(DB_KEY_SYNC_Q, []); }

/* ─── TRANSACTION CRUD (LocalStorage) ─────────────────────────────────────── */
export function getTransactionsLocal() {
  return lsGet(DB_KEY_TX, []).sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function saveTransactionLocal(tx) {
  const all = lsGet(DB_KEY_TX, []);
  const idx = all.findIndex(t => t.id === tx.id);
  if (idx >= 0) { all[idx] = tx; } else { all.push(tx); }
  lsSet(DB_KEY_TX, all);
}

export function deleteTransactionLocal(id) {
  const all = lsGet(DB_KEY_TX, []).filter(t => t.id !== id);
  lsSet(DB_KEY_TX, all);
}

/* ─── BUDGET CRUD (LocalStorage) ─────────────────────────────────────────── */
export function getBudgetsLocal() { return lsGet(DB_KEY_BUDGETS, {}); }
export function saveBudgetsLocal(budgets) { lsSet(DB_KEY_BUDGETS, budgets); }

/* ─── Firebase Dynamic Import ────────────────────────────────────────────── */
async function loadFirebase(config) {
  try {
    const { initializeApp, getApps, getApp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'
    );
    const { getFirestore, collection, doc, setDoc, deleteDoc,
            onSnapshot, getDocs, writeBatch, serverTimestamp }
      = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    // Avoid re-initializing
    _firebaseApp = getApps().length ? getApp() : initializeApp(config);
    _firestoreDb = getFirestore(_firebaseApp);

    return { collection, doc, setDoc, deleteDoc, onSnapshot,
             getDocs, writeBatch, serverTimestamp };
  } catch (err) {
    console.error('Firebase load error:', err);
    return null;
  }
}

/* ─── Connect to Firebase ────────────────────────────────────────────────── */
export async function connectFirebase(config) {
  if (!config?.apiKey || !config?.projectId) {
    setStatus('local', 'Running on LocalStorage');
    addSyncLog('ℹ️  No Firebase config — using LocalStorage', 'info');
    return false;
  }

  setStatus('syncing', 'Connecting to Firebase…');
  addSyncLog('🔄 Connecting to Firebase Firestore…', 'info');

  const fns = await loadFirebase(config);
  if (!fns) {
    setStatus('error', 'Firebase SDK failed to load');
    addSyncLog('❌ Firebase SDK load failed', 'error');
    return false;
  }

  const { collection, doc, setDoc, deleteDoc,
          onSnapshot, getDocs, writeBatch, serverTimestamp } = fns;

  // Test connectivity by reading the collection
  try {
    const txCol = collection(_firestoreDb, 'transactions');
    const snap  = await getDocs(txCol);

    // Merge remote data into local
    const remoteIds = new Set();
    snap.forEach(d => {
      remoteIds.add(d.id);
      const tx = d.data();
      saveTransactionLocal({ ...tx, id: d.id });
    });

    _isFirebaseReady = true;
    lsSet(DB_KEY_CONFIG, config);

    // Push any pending local records not in Firestore
    const localAll = lsGet(DB_KEY_TX, []);
    const batch = writeBatch(_firestoreDb);
    let pending = 0;
    localAll.forEach(tx => {
      if (!remoteIds.has(tx.id)) {
        batch.set(doc(txCol, tx.id), { ...tx, _updatedAt: serverTimestamp() });
        pending++;
      }
    });
    if (pending > 0) await batch.commit();

    // Process sync queue
    await flushSyncQueue(fns);

    setStatus('online', `Connected · ${snap.size} records`);
    addSyncLog(`✅ Firebase connected — ${snap.size} remote records`, 'success');
    _lastSyncTime = new Date();
    emit('sync', { lastSync: _lastSyncTime });

    // Set up real-time listener
    if (_unsubscribeRT) _unsubscribeRT();
    _unsubscribeRT = onSnapshot(txCol, snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          saveTransactionLocal({ ...change.doc.data(), id: change.doc.id });
        } else if (change.type === 'removed') {
          deleteTransactionLocal(change.doc.id);
        }
      });
      emit('data', { source: 'firestore' });
      addSyncLog(`🔄 Real-time update — ${snapshot.size} records`, 'info');
    });

    return true;
  } catch (err) {
    console.error('Firebase connect error:', err);
    setStatus('error', 'Connection failed — check credentials');
    addSyncLog(`❌ Error: ${err.message}`, 'error');
    return false;
  }
}

/* ─── Flush Offline Sync Queue ───────────────────────────────────────────── */
async function flushSyncQueue(fns) {
  if (!_isFirebaseReady || !fns) return;
  const q = getSyncQueue();
  if (q.length === 0) return;

  const { collection, doc, setDoc, deleteDoc, serverTimestamp } = fns;
  const txCol = collection(_firestoreDb, 'transactions');

  for (const op of q) {
    try {
      if (op.type === 'set') {
        await setDoc(doc(txCol, op.id), { ...op.data, _updatedAt: serverTimestamp() });
      } else if (op.type === 'delete') {
        await deleteDoc(doc(txCol, op.id));
      }
    } catch (e) { console.warn('Sync queue flush error:', e); }
  }

  clearSyncQueue();
  addSyncLog(`☁️  Flushed ${q.length} queued operations`, 'success');
}

/* ─── Public API: Save Transaction ──────────────────────────────────────── */
export async function saveTransaction(tx) {
  // Always save locally first
  saveTransactionLocal(tx);
  emit('data', { source: 'local' });

  if (_isOfflineMode || !_isFirebaseReady) {
    addToSyncQueue({ type: 'set', id: tx.id, data: tx });
    setStatus('offline', `Saved locally — sync pending (${getSyncQueue().length})`);
    return;
  }

  // Push to Firestore
  try {
    const fns = await loadFirebase(lsGet(DB_KEY_CONFIG, null));
    if (!fns) return;
    const { collection, doc, setDoc, serverTimestamp } = fns;
    await setDoc(doc(collection(_firestoreDb, 'transactions'), tx.id),
      { ...tx, _updatedAt: serverTimestamp() });
    _lastSyncTime = new Date();
    emit('sync', { lastSync: _lastSyncTime });
    addSyncLog(`☁️  Saved "${tx.description}" to Firestore`, 'success');
  } catch (e) {
    addToSyncQueue({ type: 'set', id: tx.id, data: tx });
    addSyncLog(`⚠️  Firestore write failed — queued locally`, 'error');
  }
}

/* ─── Public API: Delete Transaction ────────────────────────────────────── */
export async function deleteTransaction(id) {
  deleteTransactionLocal(id);
  emit('data', { source: 'local' });

  if (_isOfflineMode || !_isFirebaseReady) {
    addToSyncQueue({ type: 'delete', id });
    return;
  }

  try {
    const fns = await loadFirebase(lsGet(DB_KEY_CONFIG, null));
    if (!fns) return;
    const { collection, doc, deleteDoc } = fns;
    await deleteDoc(doc(collection(_firestoreDb, 'transactions'), id));
    addSyncLog(`🗑️  Deleted record from Firestore`, 'success');
  } catch (e) {
    addToSyncQueue({ type: 'delete', id });
  }
}

/* ─── Public API: Manual Sync ────────────────────────────────────────────── */
export async function manualSync() {
  if (_isSyncing) return;
  _isSyncing = true;
  setStatus('syncing', 'Syncing…');
  addSyncLog('🔄 Manual sync initiated…', 'info');

  const config = lsGet(DB_KEY_CONFIG, null);
  if (!config?.apiKey) {
    setStatus('local', 'LocalStorage mode — no cloud config');
    addSyncLog('ℹ️  No Firebase config set', 'info');
    _isSyncing = false;
    return;
  }

  const success = await connectFirebase(config);
  _isSyncing = false;

  if (success) {
    emit('data', { source: 'firestore' });
    _lastSyncTime = new Date();
    emit('sync', { lastSync: _lastSyncTime });
  }
}

/* ─── Public API: Toggle Offline Mode ───────────────────────────────────── */
export function setOfflineMode(offline) {
  _isOfflineMode = offline;
  if (offline) {
    if (_unsubscribeRT) { _unsubscribeRT(); _unsubscribeRT = null; }
    setStatus('offline', 'Offline mode — changes saved locally');
    addSyncLog('📴 Offline mode enabled', 'info');
  } else {
    addSyncLog('📶 Coming back online…', 'info');
    const config = lsGet(DB_KEY_CONFIG, null);
    if (config?.apiKey) connectFirebase(config);
    else setStatus('local', 'LocalStorage mode');
  }
}

/* ─── Public API: Clear All Data ─────────────────────────────────────────── */
export async function clearAllData() {
  localStorage.removeItem(DB_KEY_TX);
  localStorage.removeItem(DB_KEY_BUDGETS);
  localStorage.removeItem(DB_KEY_SYNC_Q);

  if (_isFirebaseReady && !_isOfflineMode) {
    try {
      const fns = await loadFirebase(lsGet(DB_KEY_CONFIG, null));
      if (fns) {
        const { collection, getDocs, writeBatch, doc } = fns;
        const snap = await getDocs(collection(_firestoreDb, 'transactions'));
        if (!snap.empty) {
          const batch = writeBatch(_firestoreDb);
          snap.forEach(d => batch.delete(doc(collection(_firestoreDb, 'transactions'), d.id)));
          await batch.commit();
        }
        addSyncLog('🗑️  All data cleared from Firestore', 'info');
      }
    } catch (e) { console.warn('Firestore clear error:', e); }
  }

  emit('data', { source: 'cleared' });
  addSyncLog('🗑️  All local data cleared', 'info');
}

/* ─── Public API: Get Stats ──────────────────────────────────────────────── */
export function getDbStats() {
  const txs     = lsGet(DB_KEY_TX, []);
  const qLen    = getSyncQueue().length;
  const raw     = JSON.stringify({ tx: txs }).length;
  const kb      = (raw / 1024).toFixed(1);
  return {
    total:      txs.length,
    pending:    qLen,
    lastSync:   _lastSyncTime,
    storageKB:  kb,
    mode:       _isFirebaseReady ? 'Firestore' : 'LocalStorage',
    isOnline:   _isFirebaseReady && !_isOfflineMode,
  };
}

/* ─── Public API: Get Saved Firebase Config ──────────────────────────────── */
export function getSavedConfig() { return lsGet(DB_KEY_CONFIG, null); }
export function clearFirebaseConfig() {
  lsSet(DB_KEY_CONFIG, { mode: 'local' });
  _isFirebaseReady = false;
  if (_unsubscribeRT) { _unsubscribeRT(); _unsubscribeRT = null; }
  setStatus('local', 'Disconnected — using LocalStorage');
  addSyncLog('🔌 Firebase config cleared', 'info');
}

/* ─── Initialize on Load ─────────────────────────────────────────────────── */
export async function initDb() {
  setStatus('local', 'Initializing…');
  let config = getSavedConfig();
  
  // Seed provided Firebase config by default on first load
  if (config === null) {
    config = {
      apiKey: "AIzaSyButJ-iRiHauWVIKX6x9niUHX4EghAKh84",
      authDomain: "expensetracker-9da71.firebaseapp.com",
      projectId: "expensetracker-9da71",
      storageBucket: "expensetracker-9da71.firebasestorage.app",
      messagingSenderId: "505925821291",
      appId: "1:505925821291:web:778b5464c0cc2414b9a22e",
      measurementId: "G-E995H974P1"
    };
    lsSet(DB_KEY_CONFIG, config);
    addSyncLog('📝 Seeded default Firebase configuration', 'info');
  }

  if (config?.apiKey && config?.projectId) {
    await connectFirebase(config);
  } else {
    setStatus('local', 'LocalStorage mode — no cloud config');
    addSyncLog('💾 Using LocalStorage (no Firebase config)', 'info');
  }
}
