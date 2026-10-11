/* ============================ ตั้งค่า URL ของ Apps Script API ============================ */
// นำ URL เว็บแอปที่ได้จากการ Deploy Apps Script (ลงท้ายด้วย /exec) มาใส่ตรงนี้
const API_URL = 'https://script.google.com/macros/s/AKfycbzr4Ij0kx0IeeUQjQ7B_Edsd5JdUAih6YEQL7en6hmqoIvBG0OdVv7_iKX6-YeSYGvb/exec';

/* ============================ STATE & HELPERS ============================ */
let TOKEN = sessionStorage.getItem('token') || null;
let ROLE = null, FULLNAME = null;
let currentReceiveDrug = null;
let currentDispenseDrug = null;
let selectedLotIndex = 0;
let html5QrCode = null;
let scannerTargetId = null;

function gsRun(fnName, ...args) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: fnName, args: args })
  })
    .catch(() => {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ตรวจสอบอินเทอร์เน็ต หรือค่า API_URL ใน app.js ว่าเป็นลิงก์ /exec ที่ถูกต้อง)');
    })
    .then(res => res.text().then(text => ({ status: res.status, text })))
    .then(({ status, text }) => {
      const preview = text.replace(/\s+/g, ' ').slice(0, 200);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ใช่ JSON (HTTP ' + status + ') เนื้อหา: ' + preview);
      }
      if (data && data.success) return data.result;
      if (data && data.error) throw new Error(data.error);
      throw new Error('คำตอบจากเซิร์ฟเวอร์ไม่อยู่ในรูปแบบที่คาดไว้: ' + preview);
    });
}
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 3200);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' +
    d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

/* ============================== AUTH FLOW ============================== */

window.onload = function () {
  if (TOKEN) {
    gsRun('checkSession', TOKEN).then(res => {
      if (res.valid) { onLoginSuccess(res.username, res.fullName, res.role, TOKEN); }
      else { sessionStorage.removeItem('token'); showLoginScreen(); }
    }).catch(() => showLoginScreen());
  } else {
    showLoginScreen();
  }
};

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  document.getElementById('error-msg').textContent = '';
  if (!username || !password) { document.getElementById('error-msg').textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'; return; }

  gsRun('login', username, password).then(res => {
    if (res.success) {
      onLoginSuccess(res.username, res.fullName, res.role, res.token);
    } else {
      document.getElementById('error-msg').textContent = res.message;
    }
  }).catch(err => { document.getElementById('error-msg').textContent = 'เกิดข้อผิดพลาด: ' + err.message; });
}

function onLoginSuccess(username, fullName, role, token) {
  TOKEN = token; ROLE = role; FULLNAME = fullName;
  sessionStorage.setItem('token', token);
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('hdr-name').textContent = fullName;
  document.getElementById('hdr-role').textContent = roleLabel(role);
  document.getElementById('btn-add-drug').classList.toggle('hidden', !(role === 'ADMIN' || role === 'PHARMACIST'));
  document.getElementById('admin-only-section').classList.toggle('hidden', role !== 'ADMIN');
  showPage('dashboard');
}

function roleLabel(role) {
  return {
    ADMIN: 'ผู้ดูแลระบบ',
    PHARMACIST: 'เภสัชกร',
    PHARMACY_TECH: 'เจ้าพนักงานเภสัชกรรม',
    STAFF: 'เจ้าหน้าที่'
  }[role] || role;
}

function canManageDrugs() { return ROLE === 'ADMIN' || ROLE === 'PHARMACIST'; }

function doLogout() {
  gsRun('logout', TOKEN).finally(() => {
    sessionStorage.removeItem('token');
    location.reload();
  });
}

/* ============================== NAVIGATION ============================== */

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.page === name));

  if (name === 'dashboard') loadDashboard();
  if (name === 'drugs') loadDrugList();
  if (name === 'reports') loadTransactions();
  if (name === 'users') {
    if (ROLE === 'ADMIN') { loadUsers(); loadAlertEmailsField(); }
  }
  if (name === 'receive') resetReceiveForm();
  if (name === 'dispense') resetDispenseForm();
}

/* ============================== DASHBOARD ============================== */

function loadDashboard() {
  gsRun('getDashboardSummary', TOKEN).then(sum => {
    document.getElementById('stat-drugs').textContent = sum.totalDrugs;
    document.getElementById('stat-units').textContent = sum.totalStockUnits;

    const lowEl = document.getElementById('low-stock-list');
    lowEl.innerHTML = sum.lowStock.length === 0
      ? '<p class="muted">ไม่มีรายการสต็อกต่ำ</p>'
      : sum.lowStock.map(d => `<div class="alert-item danger">${d.drugName}: คงเหลือ <b>${d.currentStock}</b> ${d.unit || ''} (ขั้นต่ำ ${d.minStock})</div>`).join('');

    const expEl = document.getElementById('near-expiry-list');
    expEl.innerHTML = sum.nearExpiry.length === 0
      ? '<p class="muted">ไม่มียาใกล้หมดอายุ</p>'
      : sum.nearExpiry.map(d => `<div class="alert-item">${d.drugName}: หมดอายุ <b>${fmtDate(d.nearestExpiry)}</b></div>`).join('');

    const exp6El = document.getElementById('near-expiry-6mo-list');
    exp6El.innerHTML = sum.nearExpiry6Months.length === 0
      ? '<p class="muted">ไม่มียาใกล้หมดอายุในช่วงนี้</p>'
      : sum.nearExpiry6Months.map(d => `<div class="alert-item">${d.drugName}: หมดอายุ <b>${fmtDate(d.nearestExpiry)}</b></div>`).join('');
  }).catch(err => toast(err.message, true));
}

/* ============================== SCANNER (กล้อง) ============================== */

async function openScanner(targetId) {
  scannerTargetId = targetId;
  document.getElementById('scanner-modal').style.display = 'block';
  html5QrCode = new Html5Qrcode('reader');
  const formats = [
    Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE
  ];
  const scanConfig = { fps: 10, qrbox: { width: 260, height: 160 }, formatsToSupport: formats };

  // ลองเปิดกล้องหลัง (environment) ก่อน
  try {
    await html5QrCode.start({ facingMode: 'environment' }, scanConfig, decodedText => onScanSuccess(decodedText));
    return;
  } catch (err1) {
    console.warn('เปิดกล้อง environment ไม่สำเร็จ:', err1);
  }

  // ถ้าไม่สำเร็จ ลองดึงรายชื่อกล้องทั้งหมดแล้วเลือกกล้องตัวสุดท้าย (มักเป็นกล้องหลัง) แทน
  try {
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras || cameras.length === 0) {
      toast('ไม่พบกล้องในอุปกรณ์นี้', true);
      closeScanner();
      return;
    }
    const cameraId = cameras[cameras.length - 1].id;
    await html5QrCode.start(cameraId, scanConfig, decodedText => onScanSuccess(decodedText));
  } catch (err2) {
    const reason = (err2 && (err2.name || err2.message)) ? (err2.name || err2.message) : String(err2);
    toast('เปิดกล้องไม่สำเร็จ: ' + reason, true);
    closeScanner();
  }
}

function onScanSuccess(decodedText) {
  const cleaned = parseBarcodeValue(decodedText);
  document.getElementById(scannerTargetId).value = cleaned;
  closeScanner();
  if (scannerTargetId === 'receive-barcode') lookupReceiveDrug();
  if (scannerTargetId === 'dispense-barcode') lookupDispenseDrug();
}

// รองรับกรณีบาร์โค้ด GS1-128 ที่มี Application Identifier (01=GTIN) นำหน้า — ตัดให้เหลือรหัสสำหรับค้นหา
function parseBarcodeValue(raw) {
  return raw.trim();
}

function closeScanner() {
  document.getElementById('scanner-modal').style.display = 'none';
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
}

/* ============================== รับเข้า ============================== */

function resetReceiveForm() {
  document.getElementById('receive-barcode').value = '';
  document.getElementById('receive-drug-info').innerHTML = '';
  document.getElementById('receive-form').classList.add('hidden');
  document.getElementById('receive-lot').value = '';
  document.getElementById('receive-expiry').value = '';
  document.getElementById('receive-qty').value = '';
  document.getElementById('receive-note').value = '';
  currentReceiveDrug = null;
  setTimeout(() => document.getElementById('receive-barcode').focus(), 100);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('receive-barcode').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupReceiveDrug(); }
  });
  document.getElementById('dispense-barcode').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupDispenseDrug(); }
  });
});

function lookupReceiveDrug() {
  const code = document.getElementById('receive-barcode').value.trim();
  if (!code) return;
  gsRun('getDrugByBarcode', TOKEN, code).then(res => {
    const infoEl = document.getElementById('receive-drug-info');
    if (res.found) {
      currentReceiveDrug = res;
      infoEl.innerHTML = `<div class="drug-info-box"><span class="name">${res.drugName}</span><br>รหัส: ${res.drugCode} · หน่วย: ${res.unit || '-'}</div>`;
      document.getElementById('receive-form').classList.remove('hidden');
      document.getElementById('receive-lot').focus();
    } else {
      currentReceiveDrug = null;
      document.getElementById('receive-form').classList.add('hidden');
      infoEl.innerHTML = `<div class="alert-item danger">ไม่พบยานี้ในระบบ (รหัส: ${res.scannedCode})
        ${canManageDrugs() ? `<br><button class="btn-small btn-primary" style="margin-top:6px;" onclick="goAddDrugFromCode('${res.scannedCode}')">+ เพิ่มยานี้เข้าระบบ</button>` : ''}</div>`;
    }
  }).catch(err => toast(err.message, true));
}

function goAddDrugFromCode(code) {
  showPage('drugs');
  openDrugForm();
  document.getElementById('drug-barcode').value = code;
}

function submitReceive() {
  if (!currentReceiveDrug) { toast('กรุณาสแกน/ค้นหายาก่อน', true); return; }
  const payload = {
    drugCode: currentReceiveDrug.drugCode,
    lotNumber: document.getElementById('receive-lot').value.trim(),
    expiryDate: document.getElementById('receive-expiry').value,
    qty: document.getElementById('receive-qty').value,
    note: document.getElementById('receive-note').value.trim()
  };
  gsRun('receiveStock', TOKEN, payload).then(res => {
    toast(res.message, false);
    resetReceiveForm();
  }).catch(err => toast(err.message, true));
}

/* ============================== จ่ายออก ============================== */

function resetDispenseForm() {
  document.getElementById('dispense-barcode').value = '';
  document.getElementById('dispense-drug-info').innerHTML = '';
  document.getElementById('dispense-form').classList.add('hidden');
  document.getElementById('dispense-lot-list').innerHTML = '';
  document.getElementById('dispense-qty').value = '';
  document.getElementById('dispense-patient').value = '';
  document.getElementById('dispense-note').value = '';
  currentDispenseDrug = null;
  selectedLotIndex = 0;
  setTimeout(() => document.getElementById('dispense-barcode').focus(), 100);
}

function lookupDispenseDrug() {
  const code = document.getElementById('dispense-barcode').value.trim();
  if (!code) return;
  gsRun('getDrugByBarcode', TOKEN, code).then(res => {
    const infoEl = document.getElementById('dispense-drug-info');
    if (!res.found) {
      currentDispenseDrug = null;
      document.getElementById('dispense-form').classList.add('hidden');
      infoEl.innerHTML = `<div class="alert-item danger">ไม่พบยานี้ในระบบ (รหัส: ${res.scannedCode})</div>`;
      return;
    }
    if (res.lots.length === 0) {
      currentDispenseDrug = null;
      document.getElementById('dispense-form').classList.add('hidden');
      infoEl.innerHTML = `<div class="drug-info-box"><span class="name">${res.drugName}</span></div><div class="alert-item danger">ไม่มีสต็อกคงเหลือของยานี้</div>`;
      return;
    }
    currentDispenseDrug = res;
    selectedLotIndex = 0;
    infoEl.innerHTML = `<div class="drug-info-box"><span class="name">${res.drugName}</span><br>รหัส: ${res.drugCode} · หน่วย: ${res.unit || '-'}</div>`;
    renderLotPicker();
    document.getElementById('dispense-form').classList.remove('hidden');
    document.getElementById('dispense-qty').focus();
  }).catch(err => toast(err.message, true));
}

function renderLotPicker() {
  const el = document.getElementById('dispense-lot-list');
  el.innerHTML = currentDispenseDrug.lots.map((l, i) => `
    <div class="lot-pick ${i === selectedLotIndex ? 'selected' : ''}" onclick="selectLot(${i})">
      <span>Lot ${l.lotNumber}</span>
      <span>คงเหลือ ${l.qty} · หมดอายุ ${fmtDate(l.expiryDate)}</span>
    </div>`).join('');
}

function selectLot(i) { selectedLotIndex = i; renderLotPicker(); }

function submitDispense() {
  if (!currentDispenseDrug) { toast('กรุณาสแกน/ค้นหายาก่อน', true); return; }
  const lot = currentDispenseDrug.lots[selectedLotIndex];
  const payload = {
    drugCode: currentDispenseDrug.drugCode,
    lotNumber: lot.lotNumber,
    qty: document.getElementById('dispense-qty').value,
    patientRef: document.getElementById('dispense-patient').value.trim(),
    note: document.getElementById('dispense-note').value.trim()
  };
  gsRun('dispenseStock', TOKEN, payload).then(res => {
    toast(res.message, false);
    resetDispenseForm();
  }).catch(err => toast(err.message, true));
}

/* ============================== รายการยา ============================== */

let drugCache = [];

function loadDrugList() {
  gsRun('getDrugList', TOKEN).then(drugs => {
    drugCache = drugs;
    renderDrugList();
  }).catch(err => toast(err.message, true));
}

function renderDrugList() {
  const filter = document.getElementById('drug-category-filter').value;
  const drugs = filter ? drugCache.filter(d => d.category === filter) : drugCache;
  const el = document.getElementById('drug-list');
  const emptyMsg = filter ? 'ไม่มีรายการยาในหมวดนี้' : 'ยังไม่มีรายการยา';
  el.innerHTML = drugs.length === 0 ? `<p class="muted">${emptyMsg}</p>` : drugs.map(d => {
    const i = drugCache.indexOf(d);
    return `
      <div class="drug-list-item" ${canManageDrugs() ? `onclick="openDrugForm(${i})" style="cursor:pointer;"` : ''}>
        <div>
          <div><b>${d.drugName}</b></div>
          <div class="meta">รหัส ${d.drugCode} ${d.barcode ? '· บาร์โค้ด ' + d.barcode : ''}${d.category ? '<br>' + d.category : ''}</div>
        </div>
        <div class="stock-pill ${d.currentStock <= d.minStock ? 'low' : 'ok'}">${d.currentStock} ${d.unit || ''}</div>
      </div>`;
  }).join('');
}

function openDrugForm(index) {
  document.getElementById('drug-form-card').classList.remove('hidden');
  const codeInput = document.getElementById('drug-code');
  if (typeof index === 'number') {
    const d = drugCache[index];
    document.getElementById('drug-form-title').textContent = 'แก้ไขข้อมูลยา';
    codeInput.value = d.drugCode; codeInput.disabled = true;
    document.getElementById('drug-barcode').value = d.barcode || '';
    document.getElementById('drug-name').value = d.drugName;
    document.getElementById('drug-unit').value = d.unit || '';
    document.getElementById('drug-min').value = d.minStock;
    document.getElementById('drug-category').value = d.category || '';
  } else {
    document.getElementById('drug-form-title').textContent = 'เพิ่มยาใหม่';
    ['drug-code', 'drug-barcode', 'drug-name', 'drug-unit', 'drug-min', 'drug-category'].forEach(id => document.getElementById(id).value = '');
    codeInput.disabled = false;
  }
}

function closeDrugForm() { document.getElementById('drug-form-card').classList.add('hidden'); }

function submitDrug() {
  const payload = {
    drugCode: document.getElementById('drug-code').value.trim(),
    barcode: document.getElementById('drug-barcode').value.trim(),
    drugName: document.getElementById('drug-name').value.trim(),
    unit: document.getElementById('drug-unit').value.trim(),
    minStock: document.getElementById('drug-min').value,
    category: document.getElementById('drug-category').value.trim()
  };
  gsRun('saveDrug', TOKEN, payload).then(res => {
    toast(res.message, false);
    closeDrugForm();
    loadDrugList();
  }).catch(err => toast(err.message, true));
}

/* ============================== รายงาน ============================== */

function loadTransactions() {
  const type = document.getElementById('report-filter').value;
  gsRun('getTransactions', TOKEN, { type }).then(rows => {
    const el = document.getElementById('tx-list');
    if (rows.length === 0) { el.innerHTML = '<p class="muted">ไม่มีรายการ</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>วันที่</th><th>ประเภท</th><th>ยา</th><th>Lot</th><th>จำนวน</th><th>โดย</th></tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td>${fmtDateTime(r.timestamp)}</td>
        <td><span class="tag ${r.type === 'RECEIVE' ? 'receive' : 'dispense'}">${r.type === 'RECEIVE' ? 'รับเข้า' : 'จ่ายออก'}</span></td>
        <td>${r.drugName}</td>
        <td>${r.lotNumber}</td>
        <td>${r.qty}</td>
        <td>${r.user}</td>
      </tr>`).join('') + `</tbody></table>`;
  }).catch(err => toast(err.message, true));
}

/* ============================== ผู้ใช้งาน (admin) ============================== */

let userCache = [];

function loadUsers() {
  gsRun('getUsers', TOKEN).then(users => {
    userCache = users;
    const el = document.getElementById('user-list');
    el.innerHTML = users.map((u, i) => `
      <div class="drug-list-item" onclick="openUserForm(${i})" style="cursor:pointer;">
        <div><b>${u.fullName}</b><div class="meta">${u.username} · ${roleLabel(u.role)}</div></div>
        <div class="stock-pill ${u.active ? 'ok' : 'low'}">${u.active ? 'ใช้งาน' : 'ระงับ'}</div>
      </div>`).join('');
  }).catch(err => toast(err.message, true));
}

function openUserForm(index) {
  document.getElementById('user-form-card').classList.remove('hidden');
  const unameInput = document.getElementById('user-username');
  if (typeof index === 'number') {
    const u = userCache[index];
    document.getElementById('user-form-title').textContent = 'แก้ไขผู้ใช้';
    unameInput.value = u.username; unameInput.disabled = true;
    document.getElementById('user-fullname').value = u.fullName;
    document.getElementById('user-role').value = u.role;
    document.getElementById('user-password').value = '';
    document.getElementById('user-active').checked = u.active;
  } else {
    document.getElementById('user-form-title').textContent = 'เพิ่มผู้ใช้ใหม่';
    unameInput.value = ''; unameInput.disabled = false;
    document.getElementById('user-fullname').value = '';
    document.getElementById('user-role').value = 'PHARMACIST';
    document.getElementById('user-password').value = '';
    document.getElementById('user-active').checked = true;
  }
}

function closeUserForm() { document.getElementById('user-form-card').classList.add('hidden'); }

function submitUser() {
  const payload = {
    username: document.getElementById('user-username').value.trim(),
    fullName: document.getElementById('user-fullname').value.trim(),
    role: document.getElementById('user-role').value,
    password: document.getElementById('user-password').value,
    active: document.getElementById('user-active').checked
  };
  gsRun('saveUser', TOKEN, payload).then(res => {
    toast(res.message, false);
    closeUserForm();
    loadUsers();
  }).catch(err => toast(err.message, true));
}

/* ============================== แจ้งเตือน / รหัสผ่าน ============================== */

function loadAlertEmailsField() {
  gsRun('getAlertEmails', TOKEN).then(v => { document.getElementById('alert-emails').value = v; }).catch(() => {});
}

function saveAlertEmails() {
  gsRun('setAlertEmails', TOKEN, document.getElementById('alert-emails').value.trim())
    .then(res => toast(res.message, false)).catch(err => toast(err.message, true));
}

function testAlert() {
  gsRun('testAlertNow', TOKEN).then(res => toast(res.message, false)).catch(err => toast(err.message, true));
}

function submitChangeOwnPassword() {
  const oldPw = document.getElementById('own-old-pw').value;
  const newPw = document.getElementById('own-new-pw').value;
  if (!oldPw || !newPw) { toast('กรุณากรอกรหัสผ่านให้ครบ', true); return; }
  gsRun('changeOwnPassword', TOKEN, oldPw, newPw).then(res => {
    toast(res.message, false);
    document.getElementById('own-old-pw').value = '';
    document.getElementById('own-new-pw').value = '';
  }).catch(err => toast(err.message, true));
}
