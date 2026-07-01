/* ================================================================
   MediCheck — Core JS
   state · navigation · auth · offline · utilities
================================================================ */

/* ── App State ─────────────────────────────────────────────── */
const App = {
    user: null,
    role: null,
    history: [],
    offline: false,
    offlineCache: {
        scans: [],
        drugs: []
    }
};

/* ── IndexedDB Queue (minimal wrapper) ─────────────────────── */
function openQueueDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('medicheck-db', 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Failed to open IDB'));
    });
}

async function enqueueVerification(item) {
    try {
        const db = await openQueueDB();
        const tx = db.transaction('queue', 'readwrite');
        const store = tx.objectStore('queue');
        await store.add({ type: 'verify', payload: item, createdAt: Date.now(), status: 'pending' });
        return tx.complete || new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (e) {
        // fallback to localStorage queue
        const q = JSON.parse(localStorage.getItem('mc_queue') || '[]');
        q.push({ type: 'verify', payload: item, createdAt: Date.now(), status: 'pending' });
        localStorage.setItem('mc_queue', JSON.stringify(q));
    }
}

async function getQueuedItems() {
    try {
        const db = await openQueueDB();
        const tx = db.transaction('queue', 'readonly');
        const store = tx.objectStore('queue');
        return new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        return JSON.parse(localStorage.getItem('mc_queue') || '[]');
    }
}

async function removeQueuedItem(id) {
    try {
        const db = await openQueueDB();
        const tx = db.transaction('queue', 'readwrite');
        const store = tx.objectStore('queue');
        store.delete(id);
        return tx.complete || new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (e) {
        const q = JSON.parse(localStorage.getItem('mc_queue') || '[]').filter(i => i.id !== id);
        localStorage.setItem('mc_queue', JSON.stringify(q));
    }
}

async function syncQueue() {
    if (!navigator.onLine) return;
    const items = await getQueuedItems();
    if (!items || items.length === 0) return;
    showToast(`Syncing ${items.length} queued requests...`, 'info');
    for (const it of items) {
        try {
            const payload = it.payload || {};
            // payload has {file, action, body}
            const res = await fetch(`${payload.file}.php?action=${payload.action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload.body)
            });
            const txt = await res.text();
            let json = {};
            try { json = JSON.parse(txt); } catch { }
            if (res.ok && json.success !== false) {
                // delete item from queue
                if (it.id) await removeQueuedItem(it.id);
            }
        } catch (e) {
            console.error('Sync failed for queued item', it, e);
        }
    }
    hideOfflineBanner();
    showToast('Queued requests synced', 'success');
}


/* ── Tiny API client ───────────────────────────────────────── */
const API = {
    base: 'api/',

    async post(file, action, body = {}) {
        // Only use offline cache when the BROWSER is actually offline, AND the action has a fallback
        if (!navigator.onLine) {
            App.offline = true;
            showOfflineBanner();
            // Queue verification POSTs for later sync
            if (action === 'verify') {
                if (window.enqueueVerification) await enqueueVerification({ file, action, body });
                return { success: true, queued: true, message: 'Verification queued for sync' };
            }
            if (action === 'history') return this._offlineFallback(action, body);
        }
        try {
            const r = await fetch(`${this.base}${file}.php?action=${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body)
            });
            const text = await r.text();
            try {
                return JSON.parse(text);
            } catch {
                console.error('Non-JSON response from', file, action, ':', text.slice(0, 300));
                return { success: false, message: `Server returned an invalid response (HTTP ${r.status}). Check that the server is running and the API path is correct.` };
            }
        } catch (e) {
            // Real network failure
            if (!navigator.onLine) {
                App.offline = true;
                showOfflineBanner();
                return this._offlineFallback(action, body);
            }
            return { success: false, message: 'Could not reach the server. Make sure your local server (XAMPP/WAMP/etc) is running.' };
        }
    },

    async get(file, action, params = {}) {
        if (!navigator.onLine && (action === 'history' || action === 'verify')) {
            App.offline = true;
            showOfflineBanner();
            return this._offlineFallback(action, {});
        }
        const qs = new URLSearchParams({ action, ...params }).toString();
        try {
            const r = await fetch(`${this.base}${file}.php?${qs}`, { credentials: 'same-origin' });
            const text = await r.text();
            try {
                return JSON.parse(text);
            } catch {
                console.error('Non-JSON response from', file, action, ':', text.slice(0, 300));
                return { success: false, message: `Server returned an invalid response (HTTP ${r.status}).` };
            }
        } catch (e) {
            if (!navigator.onLine) {
                App.offline = true;
                showOfflineBanner();
                return this._offlineFallback(action, {});
            }
            return { success: false, message: 'Could not reach the server.' };
        }
    },

    _offlineFallback(action, body) {
        if (action === 'history') {
            const cached = JSON.parse(localStorage.getItem('mc_scan_history') || '[]');
            return { success: true, history: cached };
        }
        if (action === 'verify') {
            const cached = JSON.parse(localStorage.getItem('mc_drugs') || '[]');
            const drug = cached.find(d => d.drug_id === body.drug_id);
            if (drug) return {
                success: true, result: 'genuine',
                confidence: 0, method: 'offline_cache',
                signals: [{ type: 'yellow', text: 'Offline — cached result only, reconnect to verify properly' }],
                drug
            };
            return { success: true, result: 'unknown', confidence: 0, signals: [{ type: 'red', text: 'Offline — drug not in local cache' }], drug: null };
        }
        return { success: false, message: 'Action not available offline' };
    }
};

/* ── Navigation ────────────────────────────────────────────── */
function goTo(id) {
    // Stop camera if navigating away from scan screen
    if (id !== 'screen-scan' && typeof _cameraRunning !== 'undefined' && _cameraRunning) {
        stopCamera();
    }
    // Prevent unauthorized admin access
    if (id && id.startsWith('screen-admin')) {
        if (!App.user || App.user.role !== 'admin') { showToast('Unauthorized — admin access required', 'error'); return; }
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (!el) { console.warn('Missing screen:', id); return; }
    el.classList.add('active');
    const scroll = el.querySelector('.scroll-body');
    if (scroll) scroll.scrollTop = 0;
    if (App.history[App.history.length - 1] !== id) App.history.push(id);
}

function goBack() {
    if (App.history.length > 1) {
        App.history.pop();
        const prev = App.history[App.history.length - 1];
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const el = document.getElementById(prev);
        if (el) el.classList.add('active');
    }
}

/* ── Auth ──────────────────────────────────────────────────── */
function selectRole(role) {
    App.role = role;
    document.querySelectorAll('.role-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('role-' + role)?.classList.add('selected');
}

// FIXED: use placeholder, not value, so the field stays empty for the user
function goToLogin() {
    if (!App.role) { showToast('Please select a role first', 'error'); return; }
    const labels = { user: 'User', manufacturer: 'Manufacturer', admin: 'Administrator' };
    const hints = { user: 'you@example.com', manufacturer: 'mfr@example.com', admin: 'admin@medicheck.cm' };
    setEl('loginRoleBadge', labels[App.role]);
    const em = document.getElementById('loginEmail');
    if (em) { em.value = ''; em.placeholder = hints[App.role] || 'you@example.com'; }
    const pw = document.getElementById('loginPassword');
    if (pw) pw.value = '';
    const errEl = document.getElementById('loginError');
    if (errEl) errEl.style.display = 'none';
    goTo('screen-login');
}

// FIXED: surface the real server message instead of always showing the hardcoded one
async function doLogin() {
    // Clear any stuck offline state — login must hit the server
    if (navigator.onLine) { App.offline = false; hideOfflineBanner(); }

    const email = (document.getElementById('loginEmail')?.value || '').trim();
    const pass = document.getElementById('loginPassword')?.value || '';
    const errEl = document.getElementById('loginError');
    if (errEl) errEl.style.display = 'none';

    if (!email || !pass) {
        if (errEl) {
            errEl.textContent = 'Please enter your email and password';
            errEl.style.display = 'block';
        }
        return;
    }

    setBtnLoading('loginBtn', true);
    const res = await API.post('auth', 'login', { email, password: pass });
    setBtnLoading('loginBtn', false);

    if (res.success && res.user) {
        // Normalise role coming from server and guard defaults
        const validRoles = ['user', 'manufacturer', 'admin'];
        const role = validRoles.includes(res.user.role) ? res.user.role : 'user';
        App.user = { ...res.user, role };
        syncUserUI();
        App.history = [];
        const dest = { user: 'screen-home', manufacturer: 'screen-mfr-home', admin: 'screen-admin' };
        goTo(dest[role] || 'screen-home');
        if (document.getElementById('loginPassword')) document.getElementById('loginPassword').value = '';
        if (role === 'user') loadHomeStats();
        if (role === 'manufacturer') loadMfrDrugs();
        if (role === 'admin') { loadAdminStats(); loadAlerts(); }
    } else {
        if (errEl) {
            errEl.textContent = res.message || 'Invalid email or password. Please try again.';
            errEl.style.display = 'block';
        }
    }
}

async function doRegister() {
    const get = id => document.getElementById(id)?.value?.trim() || '';
    const body = {
        name: get('regName'), email: get('regEmail'),
        password: get('regPass'), role: get('regRole'),
        company: get('regCompany'), phone: get('regPhone')
    };
    const errEl = document.getElementById('regError');
    if (errEl) errEl.style.display = 'none';
    if (!body.name || !body.email || !body.password) {
        if (errEl) { errEl.textContent = 'Name, email, and password are required'; errEl.style.display = 'block'; }
        return;
    }
    setBtnLoading('registerBtn', true);
    const res = await API.post('auth', 'register', body);
    setBtnLoading('registerBtn', false);
    if (res.success && res.user) {
        App.user = res.user;
        syncUserUI();
        App.history = [];
        const dest = { user: 'screen-home', manufacturer: 'screen-mfr-home', admin: 'screen-admin' };
        goTo(dest[res.user.role] || 'screen-home');
        // If server assigned a different role than requested (e.g., admin creation restricted), inform the user
        if (body.role && body.role !== res.user.role) {
            showToast(`Account created with role: ${res.user.role}. Admin accounts can only be created by existing administrators.`, 'info');
        } else {
            showToast('Account created! Welcome.', 'success');
        }
    } else {
        if (errEl) { errEl.textContent = res.message || 'Registration failed'; errEl.style.display = 'block'; }
    }
}

async function doLogout() {
    await API.post('auth', 'logout', {});
    App.user = null;
    App.history = [];
    goTo('screen-welcome');
    showToast('Signed out');
}

function syncUserUI() {
    if (!App.user) return;
    const u = App.user;
    const initials = u.name.trim().split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const set = (id, v) => setEl(id, v);
    set('homeAvatar', initials);
    set('homeUserName', u.name.split(' ')[0]);
    set('settingsAvatar', initials);
    set('settingsName', u.name);
    set('settingsEmail', u.email);
    set('settingsRole', { user: 'User', manufacturer: 'Manufacturer', admin: 'Administrator' }[u.role] || u.role);
    set('mfrAvatar', initials);
    set('adminAvatar', initials);
    // Set badge class based on role — no gold for user
    const roleEl = document.getElementById('settingsRole');
    if (roleEl) {
        roleEl.className = 'badge ' + (u.role === 'admin' ? 'badge-info' : 'badge-teal');
    }
}

/* ── Offline ───────────────────────────────────────────────── */
function showOfflineBanner() {
    document.querySelectorAll('.offline-banner').forEach(b => b.style.display = 'flex');
}
function hideOfflineBanner() {
    document.querySelectorAll('.offline-banner').forEach(b => b.style.display = 'none');
}
window.addEventListener('online', () => { App.offline = false; hideOfflineBanner(); showToast('Back online', 'success'); syncQueue(); });
window.addEventListener('offline', () => { App.offline = true; showOfflineBanner(); showToast('You are offline — limited mode active', 'error'); });

function cacheScansLocally(scans) {
    localStorage.setItem('mc_scan_history', JSON.stringify(scans));
}
function cacheDrugsLocally(drugs) {
    localStorage.setItem('mc_drugs', JSON.stringify(drugs));
}

/* ── Password eye toggle ───────────────────────────────────── */
function togglePw(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.innerHTML = isHidden
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

/* ── Utilities ─────────────────────────────────────────────── */
function showToast(msg, type = '') {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 2800);
}

function setBtnLoading(id, loading) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.orig = btn.dataset.orig || btn.textContent;
    btn.textContent = loading ? 'Please wait…' : btn.dataset.orig;
}

function setEl(id, val) {
    const el = document.getElementById(id); if (el) el.textContent = val ?? '—';
}

function setHTML(id, val) {
    const el = document.getElementById(id); if (el) el.innerHTML = val ?? '';
}

function toggleSwitch(el) {
    el.classList.toggle('on');
    // If this is the Two-Factor Auth toggle, open guided setup
    const parent = el.closest && el.closest('#sr-2fa');
    if (parent) {
        // If turning off, confirm; if turning on, open setup modal
        if (!el.classList.contains('on')) {
            Swal.fire({
                title: 'Disable Two-Factor Authentication?',
                text: 'Disabling 2FA will reduce account security. Are you sure?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Disable',
            }).then(r => {
                if (r.isConfirmed) {
                    save2FAMethods([]);
                    showToast('Two-Factor Authentication disabled', 'info');
                } else {
                    el.classList.add('on');
                }
            });
        } else {
            showTwoFactorModal();
        }
        return;
    }
    showToast(el.classList.contains('on') ? 'Setting enabled' : 'Setting disabled');
}

function showTwoFactorModal() {
    openTwoFactorModal();
}

function openTwoFactorModal() {
    const saved = localStorage.getItem('tfaMethod') || 'none';
    document.querySelectorAll('input[name="tfaMethod"]').forEach(r => r.checked = r.value === saved);
    updateTfaSelection();
    document.getElementById('twoFactorModal')?.classList.remove('hidden');
}

function closeTwoFactorModal() {
    document.getElementById('twoFactorModal')?.classList.add('hidden');
}

function updateTfaSelection() {
    document.querySelectorAll('.tfa-option').forEach(el => {
        el.classList.toggle('tfa-selected', el.querySelector('input[type=radio]').checked);
    });
}

async function saveTwoFactor() {
    const method = document.querySelector('input[name="tfaMethod"]:checked')?.value || 'none';
    localStorage.setItem('tfaMethod', method);
    await save2FAMethods(method === 'none' ? [] : [method]);
    const labels = { none: 'Not configured', email: 'Email OTP enabled', sms: 'SMS OTP enabled' };
    const statusEl = document.getElementById('twoFactorStatus');
    if (statusEl) statusEl.textContent = labels[method] || 'Not configured';
    closeTwoFactorModal();
    showToast(method === 'none' ? '2FA disabled' : `2FA set to ${method.toUpperCase()}`, 'success');
}

async function save2FAMethods(methods) {
    const r = await API.post('auth', 'update_2fa', { methods });
    if (!r.success) showToast(r.message || 'Failed to save 2FA settings', 'error');
}

function openEditProfileModal() {
    const user = App.user || {};
    // Pre-fill fields
    const n = document.getElementById('epName');
    const e = document.getElementById('epEmail');
    const p = document.getElementById('epPhone');
    const c = document.getElementById('epCompany');
    if (n) n.value = user.name    || '';
    if (e) e.value = user.email   || '';
    if (p) p.value = user.phone   || '';
    if (c) c.value = user.company || '';
    const errEl = document.getElementById('epError');
    if (errEl) errEl.style.display = 'none';
    document.getElementById('editProfileModal')?.classList.remove('hidden');
}

function closeEditProfileModal() {
    document.getElementById('editProfileModal')?.classList.add('hidden');
}

async function submitEditProfile() {
    const name    = document.getElementById('epName')?.value?.trim()    || '';
    const email   = document.getElementById('epEmail')?.value?.trim()   || '';
    const phone   = document.getElementById('epPhone')?.value?.trim()   || '';
    const company = document.getElementById('epCompany')?.value?.trim() || '';
    const errEl   = document.getElementById('epError');
    const btn     = document.getElementById('epBtn');
    if (errEl) errEl.style.display = 'none';
    if (!name || !email) {
        if (errEl) { errEl.textContent = 'Name and email are required.'; errEl.style.display = 'block'; }
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (errEl) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; }
        return;
    }
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
    const r = await API.post('auth', 'update_profile', { name, email, phone, company });
    if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
    if (r.success && r.user) {
        App.user = r.user;
        syncUserUI();
        closeEditProfileModal();
        showToast('Profile updated', 'success');
    } else {
        if (errEl) { errEl.textContent = r.message || 'Update failed'; errEl.style.display = 'block'; }
    }
}

function filterHistory(chip, type) {
    document.querySelectorAll('.chips-row .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    document.querySelectorAll('#historyList .list-item').forEach(item => {
        item.style.display = (type === 'all' || item.dataset.type === type) ? '' : 'none';
    });
}

function switchDrugTab(tabEl, panelId) {
    document.querySelectorAll('.drug-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.drug-tab-panel').forEach(p => p.classList.remove('active'));
    tabEl.classList.add('active');
    document.getElementById(panelId)?.classList.add('active');
}

function getGreeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function updateClock() {
    const now = new Date();
    const t = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    ['homeTime', 'mfrTime', 'adminDate'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = id === 'adminDate'
            ? now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            : `${getGreeting()} · ${t}`;
    });
}

setInterval(updateClock, 1000);
updateClock();


/* ================================================================
   MediCheck — Scan, Result, Features, Map, Risk JS
================================================================ */

/* ── Scan options ──────────────────────────────────────────── */
/* ── QR Camera Scanner ─────────────────────────────────────── */
let _html5QrScanner = null;
let _cameraRunning = false;

function selectScanOpt(opt) {
    ['qr', 'manual'].forEach(o => document.getElementById('opt-' + o)?.classList.toggle('active', o === opt));

    // Show/hide manual input area
    const manualArea = document.getElementById('manualInputArea');
    if (manualArea) manualArea.style.display = opt === 'manual' ? 'block' : 'none';

    // Show/hide camera button row
    const cameraBtnWrap = document.getElementById('cameraBtnWrap');
    if (cameraBtnWrap) cameraBtnWrap.style.display = opt === 'qr' ? 'block' : 'none';

    // Stop camera if switching away from QR mode
    if (opt !== 'qr' && _cameraRunning) stopCamera();
}

function toggleCamera() {
    if (_cameraRunning) {
        stopCamera();
    } else {
        startCamera();
    }
}

function startCamera() {
    const readerEl = document.getElementById('qr-reader');
    const idleOverlay = document.getElementById('qrIdleOverlay');
    const hint = document.getElementById('qrHint');
    const btn = document.getElementById('cameraBtn');
    const status = document.getElementById('cameraStatus');

    if (!readerEl) { showToast('Camera element not found', 'error'); return; }

    // Hide idle overlay so camera feed is visible
    if (idleOverlay) idleOverlay.style.display = 'none';
    if (hint) hint.textContent = 'Scanning… point at QR code';
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-stop" style="margin-right:8px"></i>Stop Camera'; btn.classList.replace('btn-primary', 'btn-danger'); }
    if (status) status.textContent = 'Camera is active — hold steady over the QR code';

    _html5QrScanner = new Html5Qrcode('qr-reader');

    const config = {
        fps: 10,
        qrbox: { width: 200, height: 200 },
        aspectRatio: 1.0,
        supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA]
    };

    _html5QrScanner.start(
        { facingMode: 'environment' },   // rear camera on phones
        config,
        (decodedText) => {
            // ── Success: QR code read ──────────────────────────
            stopCamera();

            // The QR payload is JSON: {"id":"MC-2025-XXXXX","drug":"...","system":"MediCheck",...}
            // Try to parse it; fall back to using the raw string as the drug ID
            let drugId = decodedText.trim().toUpperCase();
            try {
                const parsed = JSON.parse(decodedText);
                if (parsed.id) drugId = parsed.id.toUpperCase();
            } catch (e) {
                // Not JSON — treat the whole string as the drug ID
            }

            showToast('QR code read: ' + drugId, 'success');
            runVerify(drugId);
        },
        (errorMsg) => {
            // Scan errors are normal (no QR in frame yet) — ignore them
        }
    ).catch(err => {
        stopCamera();
        if (err.toString().includes('Permission')) {
            showToast('Camera permission denied — please allow camera access', 'error');
            if (status) status.textContent = 'Camera access was denied. Please allow it in your browser settings.';
        } else {
            showToast('Camera error: ' + err, 'error');
        }
    });

    _cameraRunning = true;
}

function stopCamera() {
    if (_html5QrScanner && _cameraRunning) {
        _html5QrScanner.stop().then(() => {
            _html5QrScanner.clear();
            _html5QrScanner = null;
        }).catch(() => {
            _html5QrScanner = null;
        });
    }
    _cameraRunning = false;

    // Restore idle state
    const idleOverlay = document.getElementById('qrIdleOverlay');
    const hint = document.getElementById('qrHint');
    const btn = document.getElementById('cameraBtn');
    const status = document.getElementById('cameraStatus');

    if (idleOverlay) idleOverlay.style.display = 'flex';
    if (hint) hint.textContent = 'Tap "Start Camera" to scan';
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-camera" style="margin-right:8px"></i>Start Camera'; btn.classList.replace('btn-danger', 'btn-primary'); }
    if (status) status.textContent = 'Camera stopped';
}

// Camera stops automatically via stopCamera() calls

async function scanManual() {
    const code = (document.getElementById('manualCode')?.value || '').trim().toUpperCase();
    if (!code) { showToast('Please enter a Drug ID', 'error'); return; }
    await runVerify(code);
}

async function runVerify(drugId) {
    showAIOverlay();
    const location = 'Yaoundé, CM';
    const res = await API.post('drugs', 'verify', { drug_id: drugId, location });
    hideAIOverlay();
    if (res.result !== undefined || res.success) {
        renderResult(res);
    } else {
        showToast(res.message || 'Verification failed', 'error');
    }
}

/* ── AI overlay ────────────────────────────────────────────── */
let _aiTimer = null;
function showAIOverlay() {
    const ov = document.getElementById('aiOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    const steps = ['aiStep1', 'aiStep2', 'aiStep3', 'aiStep4'];
    steps.forEach(s => {
        const el = document.getElementById(s);
        if (el) { el.classList.remove('done'); el.querySelector('.ai-step-num').textContent = s.slice(-1); }
    });
    let i = 0;
    _aiTimer = setInterval(() => {
        if (i < steps.length) {
            const el = document.getElementById(steps[i]);
            if (el) { el.classList.add('done'); el.querySelector('.ai-step-num').textContent = '✓'; }
            i++;
        }
    }, 500);
}
function hideAIOverlay() {
    clearInterval(_aiTimer);
    document.getElementById('aiOverlay')?.classList.add('hidden');
}

/* ── Render result ─────────────────────────────────────────── */
function renderResult(res) {
    const { result, confidence, signals = [], total_scans = 0, drug } = res;

    const cfgs = {
        genuine: { icon: '<i class="fa-solid fa-circle-check" style="color:var(--success)"></i>', label: 'GENUINE PRODUCT', cls: 'genuine' },
        suspect: { icon: '<i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i>', label: 'SUSPICIOUS PRODUCT', cls: 'suspect' },
        unknown: { icon: '<i class="fa-solid fa-question-circle" style="color:var(--text-3)"></i>', label: 'UNVERIFIED PRODUCT', cls: 'unknown' },
        blocked: { icon: '<i class="fa-solid fa-ban" style="color:var(--danger)"></i>', label: 'BLOCKED PRODUCT', cls: 'suspect' },
    };
    const cfg = cfgs[result] || cfgs.unknown;

    document.getElementById('resultHero')?.setAttribute('class', 'result-hero ' + cfg.cls);
    setHTML('resultEmoji', cfg.icon);
    setEl('resultStatus', cfg.label);
    const subMap = {
        genuine: 'This product has been verified as authentic by the MediCheck AI system.',
        suspect: 'This product shows signs of being counterfeit. Do NOT consume. Report to authorities immediately.',
        unknown: 'This product could not be fully verified. Consult a pharmacist before use.',
        blocked: 'This product has been BLOCKED by administrators. Do NOT consume.',
    };
    setEl('resultSub', subMap[result] || '');
    setEl('resultConf', `AI Confidence: ${Number(confidence || 0).toFixed(1)}%`);

    if (drug) {
        setEl('resName', drug.drug_name || '—');
        setEl('resMfr', drug.manufacturer_name || drug.manufacturer_company || '—');
        setEl('resId', drug.drug_id || '—');
        setEl('resBatch', drug.batch_number || '—');
        setEl('resExpiry', drug.expiry_date || '—');
        setEl('resScans', `${(total_scans || 1).toLocaleString()}× scanned`);
        setEl('detailDrugName', drug.drug_name || '—');
        setEl('detailDrugMfr', (drug.manufacturer_name || '—') + (drug.nafdac_number ? ' · ' + drug.nafdac_number : ''));
        setEl('detailGeneric', drug.generic_name || '—');
        setEl('detailCategory', drug.category || '—');
        setEl('detailForm', drug.dosage_form || '—');
        setEl('detailStrength', drug.dosage_strength || '—');
        setEl('detailStorage', drug.storage_conditions || '—');
        setEl('detailDesc', drug.description || 'No description provided.');
    } else {
        ['resName', 'resMfr', 'resId', 'resBatch', 'resExpiry', 'resScans'].forEach(id => setEl(id, '—'));
    }

    // AI card
    const aiCard = document.getElementById('aiCard');
    if (aiCard) {
        aiCard.className = 'ai-card ' + (result === 'genuine' ? '' : result === 'unknown' ? 'warn' : 'danger');
        const h4 = aiCard.querySelector('.ai-card-head h4');
        const headMap = {
            genuine: '<i class="fa-solid fa-circle-check" style="margin-right:8px;color:var(--success)"></i>All checks passed',
            suspect: '<i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;color:var(--danger)"></i>Suspicious patterns detected',
            unknown: '<i class="fa-solid fa-question-circle" style="margin-right:8px;color:var(--text-3)"></i>Limited data available',
            blocked: '<i class="fa-solid fa-ban" style="margin-right:8px;color:var(--danger)"></i>Drug is blocked'
        };
        if (h4) h4.innerHTML = headMap[result] || '';
        setEl('aiBodyText', {
            genuine: 'All verification parameters passed. QR code is registered in the official database with normal scan patterns.',
            suspect: 'High-risk patterns detected. This QR code shows signs of counterfeit distribution. Do not consume.',
            unknown: 'Drug ID not found in database. It may be unregistered or the QR code may be damaged.',
            blocked: 'This drug has been flagged and blocked by administrators.',
        }[result] || '');
        const sigEl = document.getElementById('aiSignals');
        if (sigEl) sigEl.innerHTML = (signals || []).map(s =>
            `<div class="ai-signal"><div class="sig-dot ${s.type}"></div>${s.text}</div>`
        ).join('');
    }

    // Risk prediction bar
    const riskPct = result === 'genuine' ? Math.round(100 - (confidence || 95))
        : result === 'suspect' ? Math.round(confidence || 90)
            : 50;
    setEl('riskPercent', riskPct + '%');
    const bar = document.getElementById('riskBar');
    if (bar) {
        bar.style.width = riskPct + '%';
        bar.style.background = riskPct < 25 ? 'var(--success)' : riskPct < 55 ? 'var(--warn)' : 'var(--danger)';
    }

    goTo('screen-result');
}

/* ── History ───────────────────────────────────────────────── */
async function loadHistory() {
    const list = document.getElementById('historyList');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Loading…</div>';

    const res = await API.post('reports', 'history', {});
    const history = res.history || [];
    if (history.length) cacheScansLocally(history);

    const genuine = history.filter(x => x.result === 'genuine').length;
    const suspect = history.filter(x => x.result === 'suspect').length;
    const unknown = history.length - genuine - suspect;
    setEl('histStatGenuine', genuine);
    setEl('histStatSuspect', suspect);
    setEl('histStatUnknown', unknown);

    if (!history.length) {
        list.innerHTML = `<div class="empty-state"><div class="es-icon"><i class="fa-solid fa-clipboard-list" style="font-size:20px;color:var(--text-3)"></i></div><h3>No scans yet</h3><p>Your scan history will appear here after you verify a drug.</p></div>`;
        return;
    }

    list.innerHTML = history.map(item => {
        const isG = item.result === 'genuine', isS = item.result === 'suspect';
        const icon = isG ? '<i class="fa-solid fa-pills" style="color:var(--success)"></i>' : isS ? '<i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i>' : '<i class="fa-solid fa-magnifying-glass" style="color:var(--text-3)"></i>';
        const bCls = isG ? 'badge-genuine' : isS ? 'badge-suspect' : 'badge-unknown';
        const bTxt = isG ? 'Genuine' : isS ? 'Suspect' : 'Unknown';
        const label = item.drug_name ? `${item.drug_name}${item.dosage_strength ? ' ' + item.dosage_strength : ''}` : item.drug_id;
        const d = new Date(item.scanned_at);
        const when = d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="list-item" data-type="${item.result}" onclick="runVerify('${item.drug_id}')" style="margin-bottom:10px">
                <div class="list-icon ${item.result}">${icon}</div>
                <div class="list-info">
                    <h4>${label}</h4>
                    <p>${item.manufacturer_name || '—'} · ${when}</p>
                </div>
                <span class="badge ${bCls}">${bTxt}</span>
            </div>`;
    }).join('');
}
// map
function initFakeDrugMap() {
    const cityCoords = {
        "Douala":      [4.0511,  9.7679],
        "Yaoundé":     [3.8480,  11.5021],
        "Yaounde":     [3.8480,  11.5021],
        "Buea":        [4.1527,  9.2416],
        "Bafoussam":   [5.4737,  10.4178],
        "Bamenda":     [5.9527,  10.1459],
        "Kribi":       [2.9395,  9.9082],
        "Garoua":      [9.3018,  13.3982],
        "Maroua":      [10.5908, 14.3157],
        "Ngaoundéré":  [7.3222,  13.5840],
        "Ngaoundere":  [7.3222,  13.5840],
        "Bertoua":     [4.5785,  13.6861],
        "Ebolowa":     [2.9000,  11.1500],
        "Limbe":       [4.0167,  9.2000],
        "Lagos":       [6.5244,  3.3792],
        "Abuja":       [9.0579,  7.4951],
        "Kano":        [12.0022, 8.5919],
        "Port Harcourt":[4.8156, 7.4951],
        "Accra":       [5.6037,  -0.1870],
        "Dakar":       [14.7167, -17.4677],
    };

    const mapEl = document.getElementById('map');
    if (!mapEl) return;

    // Always destroy existing map instance before reinitializing
    if (window._leafletMap) {
        window._leafletMap.remove();
        window._leafletMap = null;
    }

    // Small delay to let DOM settle after remove()
    setTimeout(() => {
        window._leafletMap = L.map('map', { zoomControl: true }).setView([4.5, 11.5], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(window._leafletMap);

        const map = window._leafletMap;

        fetch("api/drugs.php?action=map")
            .then(res => res.json())
            .then(res => {
                const data = res.map || [];

                if (data.length === 0) {
                    loadRegionSummary();
                    setTimeout(() => map.invalidateSize(), 150);
                    return;
                }

                const bounds = [];

                data.forEach(item => {
                    const loc = item.location || '';
                    const count = parseInt(item.total) || 1;

                    let coords = cityCoords[loc];
                    if (!coords) {
                        const key = Object.keys(cityCoords).find(k =>
                            k.toLowerCase() === loc.toLowerCase()
                        );
                        coords = key ? cityCoords[key] : null;
                    }
                    if (!coords) return;

                    bounds.push(coords);

                    const color  = count >= 10 ? '#EF4444' : count >= 5 ? '#F59E0B' : '#1D9E75';
                    const radius = Math.min(8 + count * 1.5, 22);

                    const circle = L.circleMarker(coords, {
                        radius, fillColor: color,
                        color: 'white', weight: 2,
                        opacity: 1, fillOpacity: 0.75
                    }).addTo(map);

                    circle.bindPopup(`
                        <div style="font-family:sans-serif;min-width:140px">
                            <div style="font-weight:700;font-size:14px;margin-bottom:4px">${loc}</div>
                            <div style="font-size:12px;color:#666">${count} scan${count !== 1 ? 's' : ''} recorded</div>
                            <div style="font-size:11px;margin-top:4px;padding:2px 8px;border-radius:99px;display:inline-block;background:${color}20;color:${color};font-weight:600">
                                ${count >= 10 ? 'High activity' : count >= 5 ? 'Medium activity' : 'Low activity'}
                            </div>
                        </div>
                    `);
                });

                if (bounds.length > 0) {
                    if (bounds.length === 1) {
                        map.setView(bounds[0], 10);
                    } else {
                        map.fitBounds(bounds, { padding: [40, 40] });
                    }
                }

                loadRegionSummary();
                setTimeout(() => map.invalidateSize(), 150);
            })
            .catch(err => {
                console.error("Map error:", err);
                loadRegionSummary();
            });
    }, 50);
}

function loadRegionSummary() {
    fetch("api/drugs.php?action=map")
        .then(res => res.json())
        .then(res => {
            const data = res.map || [];
            const container = document.getElementById("regionSummary");
            const badge = document.getElementById("mapTotalBadge");
            if (!container) return;

            container.innerHTML = "";

            if (badge) badge.textContent = `${data.length} location${data.length !== 1 ? 's' : ''}`;

            if (data.length === 0) {
                container.innerHTML = `
                  <div style="text-align:center;padding:20px 0">
                    <div style="font-size:28px;margin-bottom:8px">📍</div>
                    <div style="font-size:13px;font-weight:700;color:var(--text-1)">No locations yet</div>
                    <div style="font-size:12px;color:var(--text-3);margin-top:4px">Scan locations will appear here</div>
                  </div>`;
                return;
            }

            // Sort by count descending
            data.sort((a, b) => b.total - a.total);

            data.forEach((item, i) => {
                const count = parseInt(item.total) || 0;
                const isHigh   = count >= 10;
                const isMed    = count >= 5 && count < 10;
                const color    = isHigh ? '#EF4444' : isMed ? '#F59E0B' : '#1D9E75';
                const bgColor  = isHigh ? '#FEF2F2' : isMed ? '#FFFBEB' : '#F0FDF4';
                const label    = isHigh ? 'High' : isMed ? 'Medium' : 'Low';
                const pct      = Math.min(Math.round((count / (data[0]?.total || 1)) * 100), 100);

                const card = document.createElement("div");
                card.style.cssText = `background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;`;
                card.innerHTML = `
                  <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
                    <div style="width:36px;height:36px;border-radius:10px;background:${bgColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px">📍</div>
                    <div style="flex:1;min-width:0">
                      <div style="font-size:13px;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.location}</div>
                      <div style="font-size:11px;color:var(--text-3);margin-top:1px">${count} scan${count !== 1 ? 's' : ''} recorded</div>
                    </div>
                    <div style="background:${bgColor};color:${color};font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;flex-shrink:0">${label}</div>
                  </div>
                  <div style="background:var(--bg);border-radius:99px;height:5px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:99px;transition:width .8s cubic-bezier(.4,0,.2,1)"></div>
                  </div>`;
                container.appendChild(card);
            });
        });
}

document.addEventListener("DOMContentLoaded", loadRegionSummary);

/* ── QR Risk Prediction ────────────────────────────────────── */
function computeQRRisk(features) {
    // Client-side lightweight risk scoring for offline mode
    let score = 0;
    if ((features.scans_last_1h || 0) > 20) score += 40;
    if ((features.distinct_locations_2h || 0) >= 2) score += 30;
    if ((features.days_to_expiry || 999) < 0) score += 20;
    if ((features.scan_to_batch_ratio || 0) > 1.5) score += 15;
    if ((features.prev_suspect_flags || 0) > 0) score += 10;
    return Math.min(score, 99);
}

/* ── Manufacturer ──────────────────────────────────────────── */
async function registerDrug() {
    const get = id => document.getElementById(id)?.value?.trim() || '';
    const body = {
        drug_name: get('regDrugName'),
        generic_name: get('regGenericName'),
        category: document.getElementById('regCategory')?.value,
        dosage_strength: get('regStrength'),
        dosage_form: document.getElementById('regForm')?.value || 'Tablet',
        batch_number: get('regBatch'),
        manufacture_date: get('regManuDate'),
        expiry_date: get('regExpiryDate'),
        batch_quantity: get('regQuantity'),
        storage_conditions: get('regStorage'),
        nafdac_number: get('regNafdac'),
        description: get('regDesc'),
    };
    const errEl = document.getElementById('regDrugError');
    if (errEl) errEl.style.display = 'none';
    if (!body.drug_name || !body.batch_number || !body.manufacture_date || !body.expiry_date) {
        if (errEl) { errEl.textContent = 'Drug name, batch number, and dates are required.'; errEl.style.display = 'block'; }
        return;
    }
    setBtnLoading('registerDrugBtn', true);
    const res = await API.post('drugs', 'register', body);
    setBtnLoading('registerDrugBtn', false);
    if (!res.success) {
        if (errEl) { errEl.textContent = res.message || 'Registration failed'; errEl.style.display = 'block'; }
        return;
    }
    setEl('qrDrugName', body.drug_name);
    setEl('qrMfrName', App.user?.company || App.user?.name || '');
    setEl('qrDrugID', res.drug_id);
    setEl('qrInfoID', res.drug_id);
    setEl('qrInfoBatch', body.batch_number);
    goTo('screen-qr-output');
    setTimeout(() => generateQR(res.drug_id, body.drug_name, res.qr_payload), 200);
    showToast('Drug registered successfully!', 'success');
    loadMfrDrugs();
}

function generateQR(drugId, drugName, payload) {
    const container = document.getElementById('qrcode');
    if (!container) return;
    container.innerHTML = '';
    const text = payload || JSON.stringify({ id: drugId, drug: drugName, system: 'MediCheck' });
    if (typeof QRCode !== 'undefined') {
        new QRCode(container, { text, width: 200, height: 200, colorDark: '#1C1523', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.H });
    } else {
        container.innerHTML = `<div style="width:200px;height:200px;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:10px;gap:8px;font-size:12px;color:var(--text-3)"><span style="font-size:40px">◾</span><code style="font-size:10px">${drugId}</code></div>`;
    }
}

function downloadQR() {
    const canvas = document.querySelector('#qrcode canvas');
    if (canvas) {
        const id = document.getElementById('qrDrugID')?.textContent || 'qr';
        const a = document.createElement('a');
        a.download = `medicheck-${id}.png`;
        a.href = canvas.toDataURL();
        a.click();
        showToast('QR Code downloaded!', 'success');
    } else { showToast('QR not ready — try again in a moment', ''); }
}

async function loadMfrDrugs() {
    const list = document.getElementById('mfrDrugList');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">Loading…</div>';
    const res = await API.get('drugs', 'list');
    const drugs = res.drugs || [];
    if (drugs.length) cacheDrugsLocally(drugs);
    const totalScans = drugs.reduce((a, d) => a + parseInt(d.scan_count || 0), 0);
    setEl('mfrStatDrugs', drugs.length);
    setEl('mfrStatScans', totalScans.toLocaleString());
    setEl('mfrStatFlagged', drugs.filter(d => d.status === 'blocked').length);

    if (!drugs.length) {
        list.innerHTML = `<div class="empty-state"><div class="es-icon"><i class="fa-solid fa-pills" style="font-size:20px;color:var(--text-3)"></i></div><h3>No drugs registered yet</h3><p>Register your first drug to generate a QR code.</p></div>`;
        return;
    }
    list.innerHTML = drugs.map(d => {
        const isBlocked = d.status === 'blocked';
        const exp = new Date(d.expiry_date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
        const icon = isBlocked ? '<i class="fa-solid fa-ban" style="color:var(--danger)"></i>' : '<i class="fa-solid fa-pills" style="color:var(--primary-color)"></i>';
        return `
            <div class="list-item" style="margin-bottom:10px" onclick="showToast('Drug ID: ${d.drug_id}')">
                <div class="list-icon ${isBlocked ? 'suspect' : 'genuine'}">${icon}</div>
                <div class="list-info">
                    <h4>${d.drug_name}${d.dosage_strength ? ' ' + d.dosage_strength : ''}</h4>
                    <p>Batch: ${d.batch_number} · Exp: ${exp} · ${parseInt(d.scan_count || 0).toLocaleString()} scans</p>
                </div>
                <span class="badge ${isBlocked ? 'badge-suspect' : 'badge-genuine'}">${isBlocked ? 'Blocked' : 'Active'}</span>
            </div>`;
    }).join('');
}

/* ── Admin ─────────────────────────────────────────────────── */
async function loadAdminStats() {
    const res = await API.get('drugs', 'stats');
    if (!res.success) return;
    const s = res.stats;
    setEl('adminStatScans', (s.scans_today || 0).toLocaleString());
    setEl('adminStatAlerts', (s.active_alerts || 0).toLocaleString());
    setEl('adminStatDrugs', (s.total_drugs || 0).toLocaleString());
    setEl('adminStatGenuine', (s.genuine_count || 0).toLocaleString());
    setEl('adminStatSuspect', (s.suspect_count || 0).toLocaleString());
    setEl('adminStatReports', (s.pending_reports || 0).toLocaleString());
    setEl('adminStatMfrs', (s.manufacturers || 0).toLocaleString());
    const total = (s.genuine_count || 0) + (s.suspect_count || 0);
    const rate = total > 0 ? ((s.suspect_count / total) * 100).toFixed(1) : '0.0';
    setEl('adminStatRate', rate + '%');
    buildWeeklyChart(s.weekly_scans || []);
}

function buildWeeklyChart(data) {
    const el = document.getElementById('weeklyChart');
    if (!el) return;
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now = new Date();
    const filled = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (6 - i));
        const key = d.toISOString().split('T')[0];
        const found = data.find(r => r.day === key);
        return { day: days[d.getDay() === 0 ? 6 : d.getDay() - 1], count: found ? parseInt(found.count) : 0 };
    });
    const max = Math.max(...filled.map(f => f.count), 1);
    el.innerHTML = filled.map(r => {
        const h = Math.max(Math.round((r.count / max) * 80), r.count > 0 ? 4 : 2);
        return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center">
        <span style="font-size:10px;color:var(--text-3);margin-bottom:4px">${r.count || ''}</span>
        <div style="width:100%;height:${h}px;background:var(--rose-light);border-radius:4px 4px 0 0;transition:background .2s;cursor:pointer"
             onmouseenter="this.style.background='var(--rose)'" onmouseleave="this.style.background='var(--rose-light)'"></div>
        <span style="font-size:9px;color:var(--text-3);margin-top:4px">${r.day}</span>
      </div>`;
    }).join('');
}

async function loadAlerts(forPage = false) {
    const listId = forPage ? 'alertsPageList' : 'dashAlerts';
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px">Loading…</div>';

    const res = await API.post('reports', 'alerts', {});
    const alerts = res.alerts || [];
    const active = alerts.filter(a => a.status === 'active').length;
    setEl('activeAlertCount', active + ' Active Alert' + (active !== 1 ? 's' : ''));

    if (!alerts.length) {
        list.innerHTML = `<div class="empty-state"><div class="es-icon"><i class="fa-solid fa-check-circle" style="font-size:20px;color:var(--success)"></i></div><h3>No alerts</h3><p>System is running smoothly.</p></div>`;
        return;
    }
    const sevColor = { critical: 'var(--danger)', warning: 'var(--warn)', info: 'var(--blue)' };
    const sevIcon = { critical: '<i class="fa-solid fa-bell-on" style="color:var(--danger)"></i>', warning: '<i class="fa-solid fa-triangle-exclamation" style="color:var(--warn)"></i>', info: '<i class="fa-solid fa-info-circle" style="color:var(--blue)"></i>' };
    const shown = forPage ? alerts : alerts.slice(0, 3);
    list.innerHTML = shown.map(a => `
    <div class="card card-sm" style="border-left:4px solid ${sevColor[a.severity] || 'var(--rose)'};margin-bottom:10px;${a.status === 'resolved' ? 'opacity:.6' : ''}">
      <div style="display:flex;gap:11px">
        <div style="width:36px;height:36px;background:${sevColor[a.severity]}18;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">${sevIcon[a.severity] || '•'}</div>
        <div style="flex:1">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:4px">${a.title}</h4>
          <p style="font-size:12px;color:var(--text-2);line-height:1.5">${a.message}</p>
          <div style="font-size:11px;color:var(--text-3);margin-top:5px">${new Date(a.created_at).toLocaleString('en-GB')}${a.location ? ' · ' + a.location : ''}</div>
        </div>
      </div>
      ${a.status === 'active' ? `
        <div style="display:flex;gap:8px;margin-top:11px">
          ${a.drug_id ? `<button class="btn btn-danger btn-sm" onclick="blockDrugAdmin('${a.drug_id}',${a.id})">Block Drug</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="resolveAlert(${a.id},this)">Resolve</button>
        </div>` : `<div style="font-size:11px;color:var(--success);margin-top:8px;font-weight:700">✓ Resolved</div>`}
    </div>`).join('');
}

async function resolveAlert(id, btn) {
    btn.disabled = true; btn.textContent = '…';
    const res = await API.post('reports', 'resolve_alert', { id });
    if (res.success) { showToast('Alert resolved', 'success'); loadAlerts(); loadAlerts(true); }
    else { showToast(res.message, 'error'); btn.disabled = false; btn.textContent = 'Resolve'; }
}

async function blockDrugAdmin(drugId, alertId) {
    const res = await API.post('drugs', 'block', { drug_id: drugId });
    if (res.success) {
        showToast('Drug blocked!', 'success');
        if (alertId) await API.post('reports', 'resolve_alert', { id: alertId });
        loadAlerts(); loadAlerts(true); loadAdminStats();
    } else { showToast(res.message || 'Block failed', 'error'); }
}

async function loadHomeStats() {
    const res = await API.post('reports', 'history', {});
    const h = res.history || [];
    if (h.length) cacheScansLocally(h);
    setEl('userTotalScans', h.length.toLocaleString());
    setEl('userGenuine', h.filter(x => x.result === 'genuine').length.toLocaleString());
    setEl('userSuspect', h.filter(x => x.result === 'suspect').length.toLocaleString());

    const recentEl = document.getElementById('homeRecentScans');
    if (!recentEl) return;
    if (!h.length) {
        recentEl.innerHTML = `<div class="empty-state"><div class="es-icon"><i class="fa-solid fa-clipboard-list" style="font-size:20px;color:var(--text-3)"></i></div><h3>No scans yet</h3><p>Scan your first drug to get started.</p></div>`;
        return;
    }
    recentEl.innerHTML = h.slice(0, 4).map(item => {
        const isG = item.result === 'genuine', isS = item.result === 'suspect';
        const label = item.drug_name ? `${item.drug_name}${item.dosage_strength ? ' ' + item.dosage_strength : ''}` : item.drug_id;
        const icon = isG ? '<i class="fa-solid fa-pills" style="color:var(--success)"></i>' : isS ? '<i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i>' : '<i class="fa-solid fa-magnifying-glass" style="color:var(--text-3)"></i>';
        return `
            <div class="list-item" style="margin-bottom:10px" onclick="runVerify('${item.drug_id}')">
                <div class="list-icon ${item.result}">${icon}</div>
                <div class="list-info"><h4>${label}</h4><p>${item.manufacturer_name || '—'}</p></div>
                <span class="badge ${isG ? 'badge-genuine' : isS ? 'badge-suspect' : 'badge-unknown'}">${isG ? 'Genuine' : isS ? 'Suspect' : 'Unknown'}</span>
            </div>`;
    }).join('');
}

let _selectedSeverity = 'medium';
function selectSeverity(el, level) {
    _selectedSeverity = level;
    document.querySelectorAll('.severity-opt').forEach(o => {
        o.style.borderColor = 'var(--border)';
        o.style.background = '';
    });
    const c = { low: 'var(--success)', medium: 'var(--warn)', high: 'var(--danger)' };
    el.style.borderColor = c[level];
    el.style.background = c[level] + '15';
}

async function submitReport() {
    const get = id => document.getElementById(id)?.value?.trim() || '';
    const drugName = get('reportDrugName');
    if (!drugName) { showToast('Please enter the drug name or ID', 'error'); return; }
    setBtnLoading('submitReportBtn', true);
    const res = await API.post('reports', 'submit', {
        drug_name: drugName,
        drug_id: get('reportDrugId'),
        seller_name: get('reportSeller'),
        location: get('reportLocation'),
        severity: _selectedSeverity,
        description: get('reportDescription'),
    });
    setBtnLoading('submitReportBtn', false);
    showToast(res.success ? 'Report submitted successfully!' : (res.message || 'Failed'), res.success ? 'success' : 'error');
    if (res.success) {
        ['reportDrugName', 'reportDrugId', 'reportSeller', 'reportLocation', 'reportDescription'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        setTimeout(() => goTo(App.user?.role === 'admin' ? 'screen-admin' : 'screen-home'), 1800);
    }
}


/* ── Boot ── */
document.addEventListener('DOMContentLoaded', async function () {
    App.history = ['screen-splash'];

    // UNREGISTER any existing service workers to clear cache
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
            registrations.forEach(reg => reg.unregister());
        }).catch(() => { });
        // Clear all caches
        if ('caches' in window) {
            caches.keys().then(names => names.forEach(name => caches.delete(name)));
        }
    }

    // Check if offline
    if (!navigator.onLine) { App.offline = true; showOfflineBanner(); }

    // Load saved 2FA preference into settings status text
    const tfaSaved = localStorage.getItem('tfaMethod') || 'none';
    const tfaLabels = { none: 'Not configured', email: 'Email OTP enabled', sms: 'SMS OTP enabled' };
    const tfaStatusEl = document.getElementById('twoFactorStatus');
    if (tfaStatusEl) tfaStatusEl.textContent = tfaLabels[tfaSaved] || 'Not configured';

    // Initialize UI libraries if present
    if (window.AOS) try { AOS.init(); } catch (e) { /* ignore */ }
    // Register service worker for offline support - DISABLED FOR DEVELOPMENT
    // if ('serviceWorker' in navigator) {
    //     try {
    //         navigator.serviceWorker.register('/sw.js').then(reg => {
    //             // prompt update skip waiting flow
    //             reg.addEventListener && reg.addEventListener('updatefound', () => {
    //                 const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed') { /* new SW installed */ } });
    //             });
    //         }).catch(() => { });
    //     } catch (e) { /* ignore */ }
    // }

    // Attempt to sync any queued requests
    if (navigator.onLine) syncQueue();

    // Initialize interactive map if present
    try { if (typeof initMap === 'function') initMap(); } catch (e) { console.warn('Map init failed', e); }

    // Check existing session
    const meRes = await API.get('auth', 'me');
    if (meRes.success && meRes.user) {
        const validRoles = ['user', 'manufacturer', 'admin'];
        const role = validRoles.includes(meRes.user.role) ? meRes.user.role : 'user';
        App.user = { ...meRes.user, role };
        syncUserUI();
        const dest = { user: 'screen-home', manufacturer: 'screen-mfr-home', admin: 'screen-admin' };
        App.history = [];
        setTimeout(() => {
            goTo(dest[role] || 'screen-home');
            if (role === 'user') { loadHomeStats(); }
            if (role === 'manufacturer') { loadMfrDrugs(); }
            if (role === 'admin') { loadAdminStats(); loadAlerts(); }
        }, 2500);
    } else {
        setTimeout(() => goTo('screen-welcome'), 2500);
    }
});

/* ── Guest mode ───────────────────────────────────────────── */
function enterAsGuest() {
    window._guestMode = true;
    App.user = null;
}

/* ── Change Password Modal ──────────────────────────────────── */
function openChangePasswordModal() {
    ['cpwCurrent', 'cpwNew', 'cpwConfirm'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const errEl = document.getElementById('cpwError');
    if (errEl) errEl.style.display = 'none';
    document.getElementById('changePwModal')?.classList.remove('hidden');
}

function closeChangePwModal() {
    document.getElementById('changePwModal')?.classList.add('hidden');
}

async function submitChangePassword() {
    const current = document.getElementById('cpwCurrent')?.value?.trim() || '';
    const newPass  = document.getElementById('cpwNew')?.value?.trim()     || '';
    const confirm  = document.getElementById('cpwConfirm')?.value?.trim() || '';
    const errEl    = document.getElementById('cpwError');
    const btn      = document.getElementById('cpwBtn');
    if (errEl) errEl.style.display = 'none';
    if (!current || !newPass || !confirm) {
        if (errEl) { errEl.textContent = 'All fields are required.'; errEl.style.display = 'block'; } return;
    }
    if (newPass.length < 6) {
        if (errEl) { errEl.textContent = 'New password must be at least 6 characters.'; errEl.style.display = 'block'; } return;
    }
    if (newPass !== confirm) {
        if (errEl) { errEl.textContent = 'New passwords do not match.'; errEl.style.display = 'block'; } return;
    }
    if (btn) { btn.textContent = 'Updating…'; btn.disabled = true; }
    const r = await API.post('auth', 'change_password', { current_password: current, new_password: newPass, confirm_password: confirm });
    if (btn) { btn.textContent = 'Update Password'; btn.disabled = false; }
    if (r.success) {
        closeChangePwModal();
        showToast('Password updated successfully', 'success');
    } else {
        if (errEl) { errEl.textContent = r.message || 'Failed to update password.'; errEl.style.display = 'block'; }
    }
}

/* ── Map integration (Leaflet) ────────────────────────────── */
function initMap() {
    if (!document.getElementById('map') || typeof L === 'undefined') return;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const lightTiles = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const darkTiles = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
    const map = L.map('map', { zoomControl: true }).setView([3.848, 11.502], 6);
    L.tileLayer(prefersDark ? darkTiles : lightTiles, { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

    // Soft card around map handled by CSS; add sample markers from cached data
    const cached = JSON.parse(localStorage.getItem('mc_drugs') || '[]');
    const markers = [];
    if (cached.length) {
        cached.slice(0, 50).forEach((d, i) => {
            // If drug record contains geo, use it; otherwise spread sample points
            const lat = d.lat || 3.8 + (Math.random() - 0.5) * 2;
            const lng = d.lng || 11.5 + (Math.random() - 0.5) * 3;
            const m = L.marker([lat, lng]).addTo(map).bindPopup(`<strong>${d.name || d.drug_id || 'Drug'}</strong><div style="font-size:12px;color:var(--text-2)">${d.company || ''}</div>`);
            markers.push(m);
        });
    } else {
        // sample manufacturer / pharmacy pins
        const sample = [
            { name: 'Pharmacy A', lat: 3.85, lng: 11.50 },
            { name: 'Manufacturer X', lat: 4.05, lng: 11.60 },
            { name: 'Supplier Y', lat: 3.65, lng: 11.15 }
        ];
        sample.forEach(s => L.marker([s.lat, s.lng]).addTo(map).bindPopup(`<strong>${s.name}</strong>`));
    }

    // Fit to markers if present
    if (markers.length) {
        const group = new L.featureGroup(markers);
        map.fitBounds(group.getBounds().pad(0.2));
    }

    // Ensure map resizes when container becomes visible
    setTimeout(() => map.invalidateSize(), 600);
}

