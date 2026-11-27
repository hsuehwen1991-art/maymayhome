/**
 * MayMayHome Firebase Firestore 雲端後端引擎
 * 完整移植原 GAS 5 支檔案（01_Config_Setup ~ 05_Handlers_Finance）全部業務邏輯：
 * - 自動初始化 9 個 Firestore Collection、預設房間比例 (36:21:17) 與初始管理員 (admin / 1234)
 * - SHA-256 加鹽密碼雜湊、HMAC-SHA256 30 天滑動續期憑證、三段帳號狀態權限控管
 * - 三層動態房租連動計算引擎、雙重天數公費/電費結算、房租代墊人應收計算、常用支出選單
 * - 瓦斯雙桶追蹤（含單桶平均壽命統計與連動入帳）、HomeKit 燈泡庫與更換壽命歸檔
 * - 透過同網域 Cloudflare Worker (/api/push) 安全發送 OneSignal Web Push 推播
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

// ==================== Firebase 專案連線設定 ====================
const firebaseConfig = {
  apiKey: "AIzaSyCc7OC2lYIjOBcdV2Nehhjpagvh6Xubwq0",
  authDomain: "maymayhome.firebaseapp.com",
  projectId: "maymayhome",
  storageBucket: "maymayhome.firebasestorage.app",
  messagingSenderId: "80351496334",
  appId: "1:80351496334:web:67d8d9432badf8f07461df"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// 對應 Firestore Security Rules 核准的 9 個集合
const COLS = {
  ROOMS: 'rooms',
  ACCOUNTS: 'accounts',
  EXPENSES: 'expenses',
  SETTLEMENTS: 'settlements',
  TEMPLATES: 'templates',
  ANNOUNCEMENTS: 'announcements',
  GAS: 'gasLogs',
  HOMEKIT: 'homekitDevices',
  CONFIG: 'systemConfig'
};

const DEFAULT_EXPENSE_PRESETS = ['瓦斯費', '電燈泡', '垃圾袋', '衛生紙', '洗冷氣', '洗洗衣機'];
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天有效期

let _initPromise = null;
let _authSecretCache = null;
let _pushAppIdCache = null;
let _pushAppIdFetched = false;

// ==================== 基礎工具函式 ====================

function throwApiError(code, message) {
  const err = new Error(message);
  err.apiCode = code;
  throw err;
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function parseBool(val) {
  if (typeof val === 'boolean') return val;
  return String(val || '').trim().toUpperCase() === 'TRUE';
}

function genId(prefix) {
  const rand = Math.floor(100 + Math.random() * 900);
  return prefix + '_' + Date.now() + rand;
}

function generateTempPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * 固定以台灣時間（Asia/Taipei, UTC+8）格式化現在時間
 */
function formatNow(pattern = 'yyyy-MM-dd HH:mm') {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date()).forEach(p => {
    if (p.type !== 'literal') parts[p.type] = p.value;
  });

  const hh = parts.hour === '24' ? '00' : parts.hour;
  if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
  if (pattern === 'yyyy.MM') return `${parts.year}.${parts.month}`;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ss+08:00") {
    return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}+08:00`;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}`;
}

function formatMonthZh(monthStr) {
  if (!monthStr) return '';
  const m = String(monthStr).trim().match(/^(\d{4})[.\-\/](\d{1,2})$/);
  return m ? (m[1] + '年' + String(m[2]).padStart(2, '0') + '月') : String(monthStr);
}

function getSettlementDateStr(monthStr) {
  if (!monthStr || !monthStr.includes('.')) return '-';
  const parts = monthStr.split('.');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (isNaN(year) || isNaN(month)) return '-';
  const lastDay = new Date(year, month, 0).getDate();
  return year + '/' + String(month).padStart(2, '0') + '/' + String(lastDay).padStart(2, '0');
}

// ==================== Web Crypto 密碼雜湊與 HMAC-SHA256 Token ====================

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeStr(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlDecodeStr(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function generateRandomHex(byteLen = 20) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hashPassword(plainText, secret) {
  const data = new TextEncoder().encode(secret + '::PWD::' + String(plainText));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(digest);
}

async function verifyPassword(plainText, storedHash, secret) {
  if (!plainText || !storedHash) return false;
  const computed = await hashPassword(plainText, secret);
  return computed === String(storedHash).trim();
}

async function signHmacBase64Url(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

async function createToken(userId, secret) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = base64UrlEncodeStr(userId + '|' + exp);
  const sig = await signHmacBase64Url(payload, secret);
  return payload + '.' + sig;
}

async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'INVALID_FORMAT' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'INVALID_FORMAT' };

  const [payload, sig] = parts;
  const expectedSig = await signHmacBase64Url(payload, secret);
  if (sig !== expectedSig) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  let decoded = '';
  try {
    decoded = base64UrlDecodeStr(payload);
  } catch {
    return { valid: false, reason: 'BAD_PAYLOAD' };
  }

  const [userId, expRaw] = decoded.split('|');
  const exp = Number(expRaw);
  if (!userId || isNaN(exp) || Date.now() > exp) {
    return { valid: false, reason: 'EXPIRED' };
  }

  return { valid: true, userId, exp };
}

// ==================== Firestore 集合存取與首次自動初始化 ====================

async function getAllDocs(colName) {
  const snap = await getDocs(collection(db, colName));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

async function getSystemConfigMap() {
  const rows = await getAllDocs(COLS.CONFIG);
  const map = {};
  rows.forEach(r => {
    const k = r.key || r._id;
    if (k) map[k] = r.value !== undefined ? String(r.value) : '';
  });
  return map;
}

async function setSystemConfig(key, value, desc) {
  const ref = doc(db, COLS.CONFIG, key);
  const payload = { key, value: String(value) };
  if (desc !== undefined) payload.desc = desc;
  await setDoc(ref, payload, { merge: true });
}

async function getAuthSecret() {
  if (_authSecretCache) return _authSecretCache;
  const snap = await getDoc(doc(db, COLS.CONFIG, 'AUTH_SECRET'));
  if (snap.exists() && snap.data().value) {
    _authSecretCache = String(snap.data().value);
    return _authSecretCache;
  }
  const secret = generateRandomHex(20);
  await setSystemConfig('AUTH_SECRET', secret, 'HMAC Token 與密碼雜湊密鑰（請勿任意修改）');
  _authSecretCache = secret;
  return secret;
}

/**
 * 首次啟動自動檢查並初始化空資料庫：
 * 建立 AUTH_SECRET、3 間預設房間 (36:21:17)、預設系統設定，以及初始管理員 admin / 1234
 */
async function ensureInitialized() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const [secretSnap, accSnap, roomSnap, cfgSnap] = await Promise.all([
      getDoc(doc(db, COLS.CONFIG, 'AUTH_SECRET')),
      getDocs(collection(db, COLS.ACCOUNTS)),
      getDocs(collection(db, COLS.ROOMS)),
      getDoc(doc(db, COLS.CONFIG, 'TOTAL_RENT'))
    ]);

    let secret = secretSnap.exists() && secretSnap.data().value ? String(secretSnap.data().value) : '';
    const batch = writeBatch(db);
    let hasWrites = false;

    if (!secret) {
      secret = generateRandomHex(20);
      batch.set(doc(db, COLS.CONFIG, 'AUTH_SECRET'), {
        key: 'AUTH_SECRET',
        value: secret,
        desc: 'HMAC Token 與密碼雜湊密鑰（請勿任意修改）'
      });
      hasWrites = true;
    }
    _authSecretCache = secret;

    if (roomSnap.empty) {
      [
        { roomId: 'RM_A', name: '房間 A', weight: 36 },
        { roomId: 'RM_B', name: '房間 B', weight: 21 },
        { roomId: 'RM_C', name: '房間 C', weight: 17 }
      ].forEach(rm => {
        batch.set(doc(db, COLS.ROOMS, rm.roomId), rm);
      });
      hasWrites = true;
    }

    if (!cfgSnap.exists()) {
      const origin = (typeof location !== 'undefined' && location.origin && location.origin.startsWith('http'))
        ? location.origin
        : '';
      [
        ['TOTAL_RENT', '18500', '整戶每月總房租（所有房間計算唯一母數）'],
        ['NOTIFY_ON_EXPENSE', 'FALSE', '新增支出時，網頁推播核取方塊預設狀態'],
        ['NOTIFY_ON_ANNOUNCEMENT', 'TRUE', '發布公告時，網頁推播核取方塊預設狀態'],
        ['AUTO_SETTLE_DAY', 'LAST', '每月自動推播結算日（LAST 代表月底最後一天，或填 1~28）'],
        ['AUTO_SETTLE_TIME', '20:00', '月底自動推播時段（24小時制 HH:mm）'],
        ['APP_URL', origin, '前端公開網址（供推播點擊跳轉，尾端不加斜線）'],
        ['RENT_PAYER_USER_ID', 'USR_01', '整戶房租代墊人成員ID（留空則預設首位啟用 Admin）'],
        ['EXPENSE_PRESET_ITEMS', JSON.stringify(DEFAULT_EXPENSE_PRESETS), '公費支出常用項目下拉選單（JSON 陣列）']
      ].forEach(([key, value, desc]) => {
        batch.set(doc(db, COLS.CONFIG, key), { key, value, desc });
      });
      hasWrites = true;
    }

    if (accSnap.empty) {
      const defaultHash = await hashPassword('1234', secret);
      batch.set(doc(db, COLS.ACCOUNTS, 'USR_01'), {
        userId: 'USR_01',
        displayName: '管理員',
        username: 'admin',
        passwordHash: defaultHash,
        role: 'Admin',
        roomId: 'RM_A',
        defaultDays: 30,
        status: '啟用',
        mustResetPassword: true,
        sortOrder: 1,
        lastLoginAt: ''
      });
      hasWrites = true;
    }

    if (hasWrites) {
      await batch.commit();
    }
  })().catch(err => {
    _initPromise = null;
    throw err;
  });

  return _initPromise;
}

// ==================== OneSignal 推播（經由 Cloudflare Worker 轉發） ====================

async function getPushAppId() {
  if (_pushAppIdFetched) return _pushAppIdCache || '';
  _pushAppIdFetched = true;
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    _pushAppIdCache = '';
    return '';
  }
  try {
    const res = await fetch('/api/push-config', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      _pushAppIdCache = json.appId || '';
    }
  } catch {
    _pushAppIdCache = '';
  }
  return _pushAppIdCache || '';
}

async function getActiveUserIds(includePendingElec = false) {
  const accounts = await getAllDocs(COLS.ACCOUNTS);
  return accounts
    .filter(a => a.status === '啟用' || (includePendingElec && a.status === '待結電費'))
    .map(a => a.userId);
}

async function sendOneSignalPush(opts) {
  try {
    const targetUserIds = (opts.userIds && opts.userIds.length > 0)
      ? opts.userIds
      : await getActiveUserIds(false);

    if (targetUserIds.length === 0) {
      return { sent: false, reason: 'NO_RECIPIENTS' };
    }

    const config = await getSystemConfigMap();
    const appUrl = (config.APP_URL || (typeof location !== 'undefined' ? location.origin : '')).replace(/\/$/, '');

    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: opts.title,
        message: opts.message,
        userIds: targetUserIds,
        path: opts.path || '',
        appUrl: appUrl,
        data: opts.data || null
      })
    });

    if (!res.ok) {
      return { sent: false, statusCode: res.status };
    }
    return await res.json();
  } catch (err) {
    console.warn('OneSignal push skipped:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ==================== 系統設定輔助與三層房租引擎 ====================

async function getRentPayerUserId(configMap = null, accountsList = null) {
  const config = configMap || await getSystemConfigMap();
  const configured = String(config.RENT_PAYER_USER_ID || '').trim();
  if (configured) return configured;

  const accounts = accountsList || await getAllDocs(COLS.ACCOUNTS);
  const admins = accounts
    .filter(a => a.role === 'Admin' && a.status === '啟用')
    .sort((a, b) => parseNumber(a.sortOrder) - parseNumber(b.sortOrder));
  return admins.length > 0 ? admins[0].userId : '';
}

async function getExpensePresets(configMap = null) {
  const config = configMap || await getSystemConfigMap();
  if (config.EXPENSE_PRESET_ITEMS === undefined || config.EXPENSE_PRESET_ITEMS === '') {
    return DEFAULT_EXPENSE_PRESETS.slice();
  }
  try {
    const arr = JSON.parse(config.EXPENSE_PRESET_ITEMS);
    return Array.isArray(arr) ? arr : DEFAULT_EXPENSE_PRESETS.slice();
  } catch {
    return DEFAULT_EXPENSE_PRESETS.slice();
  }
}

async function saveExpensePresets(list) {
  const cleaned = [];
  (list || []).forEach(v => {
    const s = String(v || '').trim();
    if (s && cleaned.indexOf(s) === -1) cleaned.push(s);
  });
  await setSystemConfig(
    'EXPENSE_PRESET_ITEMS',
    JSON.stringify(cleaned),
    '公費支出常用項目下拉選單（JSON 陣列）'
  );
  return cleaned;
}

async function addExpensePreset(itemName) {
  const s = String(itemName || '').trim();
  if (!s) return await getExpensePresets();
  const list = await getExpensePresets();
  if (list.indexOf(s) === -1) {
    list.push(s);
    return await saveExpensePresets(list);
  }
  return list;
}

async function calculateRentPreview(overrideTotalRent, overrideRooms, overrideAccounts) {
  const [config, roomsRaw, accountsRaw] = await Promise.all([
    overrideTotalRent !== undefined ? Promise.resolve({}) : getSystemConfigMap(),
    overrideRooms ? Promise.resolve(overrideRooms) : getAllDocs(COLS.ROOMS),
    overrideAccounts ? Promise.resolve(overrideAccounts) : getAllDocs(COLS.ACCOUNTS)
  ]);

  const totalRent = overrideTotalRent !== undefined
    ? parseNumber(overrideTotalRent)
    : parseNumber(config.TOTAL_RENT);

  const rooms = roomsRaw.map(r => ({
    roomId: r.roomId,
    name: r.name,
    weight: parseNumber(r.weight)
  })).sort((a, b) => a.roomId.localeCompare(b.roomId));

  const accounts = accountsRaw.map(a => ({
    userId: a.userId,
    displayName: a.displayName,
    roomId: a.roomId,
    status: a.status
  }));

  const totalWeight = rooms.reduce((sum, r) => sum + parseNumber(r.weight), 0);
  const warnings = [];
  let roomRentSum = 0;
  let allocatedMemberSum = 0;

  const roomResults = rooms.map(r => {
    const weight = parseNumber(r.weight);
    const roomRent = totalWeight > 0 ? Math.round(totalRent * (weight / totalWeight)) : 0;
    const activeMembers = accounts.filter(a => a.roomId === r.roomId && a.status === '啟用');
    const activeCount = activeMembers.length;
    const perPersonRent = activeCount > 0 ? Math.round(roomRent / activeCount) : 0;

    roomRentSum += roomRent;
    allocatedMemberSum += perPersonRent * activeCount;

    if (activeCount === 0 && roomRent > 0) {
      warnings.push(r.name + ' 目前無人承租（' + roomRent.toLocaleString() + ' 元未分配）');
    }

    return {
      roomId: r.roomId,
      name: r.name,
      weight,
      roomRent,
      activeCount,
      activeMembers: activeMembers.map(m => ({ userId: m.userId, displayName: m.displayName })),
      perPersonRent
    };
  });

  const roomDiff = roomRentSum - totalRent;
  const allocatedDiff = allocatedMemberSum - totalRent;

  if (roomDiff !== 0) {
    warnings.push('各房比例四捨五入加總與總房租差額：' + (roomDiff > 0 ? '+' : '') + roomDiff + ' 元');
  } else if (allocatedDiff !== 0 && warnings.length === 0) {
    warnings.push('同房對分四捨五入後與總房租差額：' + (allocatedDiff > 0 ? '+' : '') + allocatedDiff + ' 元');
  }

  return {
    totalRent,
    totalWeight,
    rooms: roomResults,
    rentSumCheck: {
      roomRentSum,
      allocatedSum: allocatedMemberSum,
      diff: allocatedDiff
    },
    warnings
  };
}

// ==================== 身分驗證與上線時間節流 ====================

async function touchUserLastLogin(userId, forceUpdate = false, currentLastLogin = '') {
  if (!userId) return currentLastLogin || '';
  const nowStr = formatNow();

  if (!forceUpdate && currentLastLogin) {
    const dt = new Date(String(currentLastLogin).replace(' ', 'T') + ':00+08:00');
    if (!isNaN(dt.getTime()) && (Date.now() - dt.getTime()) < 10 * 60 * 1000) {
      return currentLastLogin;
    }
  }

  try {
    await updateDoc(doc(db, COLS.ACCOUNTS, userId), { lastLoginAt: nowStr });
  } catch (e) {
    console.warn('touchUserLastLogin skipped:', e.message);
  }
  return nowStr;
}

async function authenticateRequest(token, requiredLevel) {
  const secret = await getAuthSecret();
  const check = await verifyToken(token, secret);
  if (!check.valid) {
    throwApiError('UNAUTHORIZED', '登入憑證無效或已過期，請重新登入');
  }

  const accSnap = await getDoc(doc(db, COLS.ACCOUNTS, check.userId));
  if (!accSnap.exists()) {
    throwApiError('UNAUTHORIZED', '查無此帳號，請重新登入');
  }

  const acc = accSnap.data();
  if (acc.status === '停用') {
    throwApiError('ACCOUNT_DISABLED', '此帳號已停用，若有帳務問題請聯繫管理員');
  }

  const user = {
    userId: acc.userId,
    displayName: acc.displayName,
    username: acc.username,
    role: acc.role,
    roomId: acc.roomId || '',
    defaultDays: parseNumber(acc.defaultDays) || 30,
    status: acc.status,
    mustResetPassword: parseBool(acc.mustResetPassword),
    sortOrder: parseNumber(acc.sortOrder),
    lastLoginAt: acc.lastLoginAt || ''
  };

  if (acc.status === '待結電費' && requiredLevel !== 'AllRead') {
    throwApiError('FORBIDDEN', '目前帳號為「待結電費」唯讀狀態，僅能檢視帳單');
  }

  if (requiredLevel === 'Admin' && user.role !== 'Admin') {
    throwApiError('FORBIDDEN', '此操作僅限管理員（Admin）執行');
  }

  return user;
}

async function buildAuthEnvelope(user) {
  const [freshSnap, config, secret, pushAppId] = await Promise.all([
    getDoc(doc(db, COLS.ACCOUNTS, user.userId)),
    getSystemConfigMap(),
    getAuthSecret(),
    getPushAppId()
  ]);

  const fresh = freshSnap.exists() ? freshSnap.data() : user;
  const lastLoginAt = await touchUserLastLogin(user.userId, false, fresh.lastLoginAt || '');
  const token = await createToken(user.userId, secret);

  return {
    token,
    user: {
      userId: user.userId,
      displayName: fresh.displayName,
      username: fresh.username,
      role: fresh.role,
      roomId: fresh.roomId || '',
      status: fresh.status,
      mustResetPassword: parseBool(fresh.mustResetPassword),
      lastLoginAt
    },
    uiDefaults: {
      notifyOnExpense: parseBool(config.NOTIFY_ON_EXPENSE),
      notifyOnAnnouncement: parseBool(config.NOTIFY_ON_ANNOUNCEMENT)
    },
    pushAppId
  };
}

// ==================== 1. 驗證模組 Handlers ====================

async function handleAuthLogin(data) {
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '').trim();
  if (!username || !password) {
    throwApiError('VALIDATION_ERROR', '請輸入帳號與密碼');
  }

  const [accounts, secret, config, pushAppId] = await Promise.all([
    getAllDocs(COLS.ACCOUNTS),
    getAuthSecret(),
    getSystemConfigMap(),
    getPushAppId()
  ]);

  const acc = accounts.find(a => String(a.username || '').toLowerCase() === username);
  if (!acc || !(await verifyPassword(password, acc.passwordHash, secret))) {
    throwApiError('UNAUTHORIZED', '帳號或密碼錯誤');
  }
  if (acc.status === '停用') {
    throwApiError('ACCOUNT_DISABLED', '此帳號已被停用');
  }

  const [lastLoginAt, token] = await Promise.all([
    touchUserLastLogin(acc.userId, true, acc.lastLoginAt),
    createToken(acc.userId, secret)
  ]);

  return {
    _message: '登入成功',
    token,
    user: {
      userId: acc.userId,
      displayName: acc.displayName,
      username: acc.username,
      role: acc.role,
      roomId: acc.roomId || '',
      status: acc.status,
      mustResetPassword: parseBool(acc.mustResetPassword),
      lastLoginAt
    },
    uiDefaults: {
      notifyOnExpense: parseBool(config.NOTIFY_ON_EXPENSE),
      notifyOnAnnouncement: parseBool(config.NOTIFY_ON_ANNOUNCEMENT)
    },
    pushAppId
  };
}

async function handleAuthVerify(user) {
  const env = await buildAuthEnvelope(user);
  return { _message: '憑證有效', ...env };
}

async function handleAuthChangePassword(user, data) {
  const oldPassword = String(data.oldPassword || '').trim();
  const newPassword = String(data.newPassword || '').trim();
  if (!newPassword || newPassword.length < 4) {
    throwApiError('VALIDATION_ERROR', '新密碼至少需 4 碼');
  }

  const [accSnap, secret] = await Promise.all([
    getDoc(doc(db, COLS.ACCOUNTS, user.userId)),
    getAuthSecret()
  ]);
  if (!accSnap.exists()) throwApiError('NOT_FOUND', '找不到帳號');
  const acc = accSnap.data();

  if (!parseBool(acc.mustResetPassword) && !(await verifyPassword(oldPassword, acc.passwordHash, secret))) {
    throwApiError('VALIDATION_ERROR', '舊密碼輸入不正確');
  }

  const newHash = await hashPassword(newPassword, secret);
  const nowStr = formatNow();
  await updateDoc(doc(db, COLS.ACCOUNTS, user.userId), {
    passwordHash: newHash,
    mustResetPassword: false,
    lastLoginAt: nowStr
  });

  return { _message: '密碼已更新完成', mustResetPassword: false, lastLoginAt: nowStr };
}

async function handleAuthResetPassword(adminUser, data) {
  const targetUserId = String(data.userId || '').trim();
  if (!targetUserId) throwApiError('VALIDATION_ERROR', '缺少目標成員 ID');

  const [accSnap, secret] = await Promise.all([
    getDoc(doc(db, COLS.ACCOUNTS, targetUserId)),
    getAuthSecret()
  ]);
  if (!accSnap.exists()) throwApiError('NOT_FOUND', '查無該成員帳號');
  const acc = accSnap.data();

  const tempPassword = generateTempPin();
  const newHash = await hashPassword(tempPassword, secret);

  await updateDoc(doc(db, COLS.ACCOUNTS, targetUserId), {
    passwordHash: newHash,
    mustResetPassword: true
  });

  return {
    _message: '已重設密碼，請將臨時密碼轉交成員',
    userId: acc.userId,
    displayName: acc.displayName,
    username: acc.username,
    tempPassword
  };
}

// ==================== 2. 首頁摘要與家庭公告 Handlers ====================

function formatAnnouncement(r) {
  return {
    id: r.id || r._id,
    createdAt: r.createdAt || '',
    authorId: r.authorId || '',
    authorName: r.authorName || '',
    priority: r.priority || '一般',
    content: r.content || '',
    status: r.status || '顯示'
  };
}

async function handleDashboardGetSummary(user) {
  const [annRaw, gasRaw, settlements, config, accounts] = await Promise.all([
    getAllDocs(COLS.ANNOUNCEMENTS),
    getAllDocs(COLS.GAS),
    getAllDocs(COLS.SETTLEMENTS),
    getSystemConfigMap(),
    getAllDocs(COLS.ACCOUNTS)
  ]);

  const announcements = annRaw
    .filter(a => a.status === '顯示')
    .map(formatAnnouncement)
    .sort((a, b) => {
      if (a.priority === '置頂' && b.priority !== '置頂') return -1;
      if (a.priority !== '置頂' && b.priority === '置頂') return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });

  const gasInfo = computeGasStatusFromRaw(gasRaw);

  const months = Array.from(new Set(settlements.map(s => s.month).filter(Boolean))).sort().reverse();
  let financeOverview = null;

  if (months.length > 0) {
    const latestMonth = months[0];
    const mSettlements = settlements.filter(s => s.month === latestMonth);
    const expSnap = await getDocs(query(collection(db, COLS.EXPENSES), where('month', '==', latestMonth)));
    const mExpenses = expSnap.docs.map(d => d.data());
    const rentPayerUserId = await getRentPayerUserId(config, accounts);

    let totalShared = 0;
    let totalElec = 0;
    mExpenses.forEach(e => {
      const amt = parseNumber(e.amount);
      if (e.category === '電費') totalElec += amt;
      else totalShared += amt;
    });

    const hasRentPayer = mSettlements.some(s => rentPayerUserId && s.userId === rentPayerUserId);
    const trackRows = hasRentPayer
      ? mSettlements.filter(s => s.userId !== rentPayerUserId)
      : mSettlements;
    const paidCount = trackRows.filter(s => s.paymentStatus === '已繳清').length;

    const myRow = mSettlements.find(s => s.userId === user.userId);
    let mySettlement = null;
    if (myRow) {
      const isRentPayer = Boolean(rentPayerUserId && myRow.userId === rentPayerUserId);
      let myStatus = myRow.paymentStatus;
      if (isRentPayer) {
        if (trackRows.length > 0 && trackRows.every(s => s.paymentStatus === '已繳清')) {
          myStatus = '已全數收齊';
        } else if (trackRows.some(s => s.paymentStatus === '待繳款' || s.paymentStatus === '待退款')) {
          myStatus = '待收款';
        } else {
          myStatus = '未結算';
        }
      }
      mySettlement = {
        amount: parseNumber(myRow.finalAmount),
        paymentStatus: myStatus,
        isRentPayer
      };
    }

    financeOverview = {
      currentMonth: latestMonth,
      settlementDate: getSettlementDateStr(latestMonth),
      totalShared,
      totalElec,
      mySettlement,
      paymentProgress: {
        paidCount,
        totalCount: trackRows.length
      }
    };
  }

  return {
    announcements,
    gasStatus: gasInfo.status,
    financeOverview
  };
}

async function handleAnnouncementList(user, data) {
  const statusFilter = String(data.status || '').trim();
  let list = (await getAllDocs(COLS.ANNOUNCEMENTS)).map(formatAnnouncement);
  if (statusFilter) {
    list = list.filter(a => a.status === statusFilter);
  }
  list.sort((a, b) => {
    if (a.status === '顯示' && a.priority !== b.priority) {
      return a.priority === '置頂' ? -1 : 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  return { announcements: list };
}

async function handleAnnouncementCreate(user, data) {
  const content = String(data.content || '').trim();
  if (!content) throwApiError('VALIDATION_ERROR', '公告內容不可為空');

  let priority = String(data.priority || '一般').trim();
  if (priority === '置頂' && user.role !== 'Admin') {
    priority = '一般';
  }

  const id = genId('ANN');
  const nowStr = formatNow();
  const docData = {
    id,
    createdAt: nowStr,
    authorId: user.userId,
    authorName: user.displayName,
    priority,
    content,
    status: '顯示'
  };

  await setDoc(doc(db, COLS.ANNOUNCEMENTS, id), docData);

  let pushResult = null;
  if (data.notifyPush) {
    const tag = priority === '置頂' ? '📌【置頂公告】' : '📢【家庭公告】';
    pushResult = await sendOneSignalPush({
      title: tag + user.displayName + ' 發布了新消息',
      message: content.length > 100 ? content.slice(0, 100) + '...' : content,
      path: '/index.html'
    });
  }

  return {
    _message: '公告已發布',
    announcement: docData,
    pushResult
  };
}

async function handleAnnouncementUpdate(user, data) {
  const id = String(data.id || '').trim();
  if (!id) throwApiError('VALIDATION_ERROR', '缺少公告 ID');

  const ref = doc(db, COLS.ANNOUNCEMENTS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該則公告');
  const target = snap.data();

  const isOwner = target.authorId === user.userId;
  if (user.role !== 'Admin' && !isOwner) {
    throwApiError('FORBIDDEN', '您只能編輯或封存自己發布的公告');
  }

  const newContent = data.content !== undefined ? String(data.content).trim() : target.content;
  if (!newContent) throwApiError('VALIDATION_ERROR', '公告內容不可為空');

  let newPriority = target.priority || '一般';
  if (data.priority !== undefined) {
    if (user.role !== 'Admin') {
      throwApiError('FORBIDDEN', '僅管理員可變更公告置頂狀態');
    }
    newPriority = data.priority === '置頂' ? '置頂' : '一般';
  }

  const newStatus = data.status !== undefined
    ? (data.status === '已封存' ? '已封存' : '顯示')
    : (target.status || '顯示');

  await updateDoc(ref, {
    content: newContent,
    priority: newPriority,
    status: newStatus
  });

  return {
    _message: newStatus === '已封存' ? '公告已封存' : '公告已更新',
    announcement: {
      ...target,
      content: newContent,
      priority: newPriority,
      status: newStatus
    }
  };
}

// ==================== 3. 瓦斯雙桶與 HomeKit 設備 Handlers ====================

function computeGasStatusFromRaw(rawDocs) {
  const rawLogs = rawDocs.map(r => ({
    id: r.id || r._id,
    time: r.time || '',
    actionType: r.actionType || '',
    operatorId: r.operatorId || '',
    operatorName: r.operatorName || '',
    remainingTanks: parseNumber(r.remainingTanks),
    note: r.note || ''
  }));

  const asc = rawLogs.slice().sort((a, b) => a.time.localeCompare(b.time));
  let lastRefillDate = null;
  const durations = [];

  asc.forEach(log => {
    const dt = new Date(log.time.replace(' ', 'T') + ':00+08:00');
    if (isNaN(dt.getTime())) return;
    if (log.actionType === '新瓦斯補滿') {
      lastRefillDate = dt;
    } else if (log.actionType === '切換備用桶' && lastRefillDate) {
      const diffDays = Math.round((dt.getTime() - lastRefillDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 0) durations.push(diffDays);
      lastRefillDate = null;
    }
  });

  const avgDaysPerTank = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  const desc = asc.slice().reverse();
  const latest = desc[0] || null;
  let daysSinceLastAction = 0;

  if (latest) {
    const dt = new Date(latest.time.replace(' ', 'T') + ':00+08:00');
    if (!isNaN(dt.getTime())) {
      daysSinceLastAction = Math.max(0, Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24)));
    }
  }

  return {
    status: {
      remainingTanks: latest ? latest.remainingTanks : 2,
      lastAction: latest ? latest.actionType : '尚無紀錄',
      lastOperator: latest ? latest.operatorName : '-',
      lastTime: latest ? latest.time : '-',
      daysSinceLastSwitch: daysSinceLastAction,
      avgDaysPerTank,
      lastCompletedTankDays: durations.length > 0 ? durations[durations.length - 1] : null
    },
    logs: desc
  };
}

async function computeGasStatusAndLogs() {
  const rawDocs = await getAllDocs(COLS.GAS);
  return computeGasStatusFromRaw(rawDocs);
}

async function handleGasGetStatusAndLogs() {
  return await computeGasStatusAndLogs();
}

async function handleGasSwitchBackup(user, data) {
  const note = String(data.note || '').trim();
  const id = genId('GAS');
  const nowStr = formatNow();

  await setDoc(doc(db, COLS.GAS, id), {
    id,
    time: nowStr,
    actionType: '切換備用桶',
    operatorId: user.userId,
    operatorName: user.displayName,
    remainingTanks: 1,
    note
  });

  const updated = await computeGasStatusAndLogs();
  const daysHint = updated.status.lastCompletedTankDays
    ? '（上一桶使用了 ' + updated.status.lastCompletedTankDays + ' 天）'
    : '';

  await sendOneSignalPush({
    title: '🔥 瓦斯已切換至第 2 桶（剩餘 1 桶）',
    message: user.displayName + ' 於 ' + nowStr.slice(5) + ' 手動換上備用桶' + daysHint + '，目前無備用桶請留意叫瓦斯！' + (note ? ' 備註：' + note : ''),
    path: '/home.html'
  });

  return {
    _message: '已記錄切換至備用桶並通知全員',
    ...updated
  };
}

async function handleGasRefillFull(user, data) {
  const note = String(data.note || '').trim();
  const id = genId('GAS');
  const nowStr = formatNow();

  await setDoc(doc(db, COLS.GAS, id), {
    id,
    time: nowStr,
    actionType: '新瓦斯補滿',
    operatorId: user.userId,
    operatorName: user.displayName,
    remainingTanks: 2,
    note
  });

  let createdExpense = null;
  if (data.createExpense && data.createExpense.enabled) {
    const expCfg = data.createExpense;
    const amount = parseNumber(expCfg.amount);
    const month = String(expCfg.month || formatNow('yyyy.MM')).trim();
    if (amount > 0) {
      createdExpense = await createExpenseInternal(user, {
        month,
        date: formatNow('yyyy-MM-dd'),
        category: '一般公費',
        item: expCfg.item || '瓦斯費',
        amount,
        paidByUserId: expCfg.paidByUserId || user.userId,
        note: note || '由瓦斯補滿自動入帳',
        notifyPush: false
      });
    }
  }

  const expenseHint = createdExpense
    ? '，並已同步計入 ' + formatMonthZh(createdExpense.month) + ' 公費支出（' + createdExpense.amount.toLocaleString() + ' 元）'
    : '';

  await sendOneSignalPush({
    title: '✅ 新瓦斯已送達（2 桶滿載）',
    message: user.displayName + ' 已確認新瓦斯補滿' + expenseHint + (note ? '。備註：' + note : ''),
    path: '/home.html'
  });

  const updated = await computeGasStatusAndLogs();
  return {
    _message: '已更新為 2 桶滿載並通知全員',
    ...updated,
    createdExpense
  };
}

function formatHomekitRow(r) {
  const activeDate = r.activeDate || '';
  let serviceDays = null;
  if (activeDate) {
    const dt = new Date(activeDate + 'T00:00:00+08:00');
    if (!isNaN(dt.getTime())) {
      serviceDays = Math.max(0, Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24)));
    }
  }
  return {
    deviceId: r.deviceId || r._id,
    room: r.room || '',
    name: r.name || '',
    pairingCode: r.pairingCode || '',
    model: r.model || '',
    activeDate,
    serviceDays,
    history: r.history || ''
  };
}

async function handleHomeGetSummary() {
  const [gasRaw, hkRaw] = await Promise.all([
    getAllDocs(COLS.GAS),
    getAllDocs(COLS.HOMEKIT)
  ]);
  return {
    gas: computeGasStatusFromRaw(gasRaw),
    devices: hkRaw.map(formatHomekitRow)
  };
}

async function handleHomekitList() {
  const hkRaw = await getAllDocs(COLS.HOMEKIT);
  return { devices: hkRaw.map(formatHomekitRow) };
}

async function handleHomekitSaveDevice(user, data) {
  const room = String(data.room || '').trim();
  const name = String(data.name || '').trim();
  const pairingCode = String(data.pairingCode || '').trim();
  const model = String(data.model || '').trim();
  const activeDate = String(data.activeDate || formatNow('yyyy-MM-dd')).trim();

  if (!room || !name) {
    throwApiError('VALIDATION_ERROR', '所屬空間與 HomeKit 名稱不可為空');
  }

  if (data.deviceId) {
    const ref = doc(db, COLS.HOMEKIT, data.deviceId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該 HomeKit 設備');
    const prev = snap.data();
    await updateDoc(ref, {
      room,
      name,
      pairingCode,
      model,
      activeDate,
      history: data.history !== undefined ? String(data.history) : (prev.history || '')
    });
    return { _message: '設備資訊已更新', deviceId: data.deviceId };
  } else {
    const newId = genId('HK');
    await setDoc(doc(db, COLS.HOMEKIT, newId), {
      deviceId: newId,
      room,
      name,
      pairingCode,
      model,
      activeDate,
      history: ''
    });
    return { _message: '已新增 HomeKit 設備', deviceId: newId };
  }
}

async function handleHomekitReplaceBulb(user, data) {
  const deviceId = String(data.deviceId || '').trim();
  const replaceDate = String(data.replaceDate || formatNow('yyyy-MM-dd')).trim();
  if (!deviceId) throwApiError('VALIDATION_ERROR', '缺少設備 ID');

  const ref = doc(db, COLS.HOMEKIT, deviceId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該 HomeKit 設備');
  const target = snap.data();

  const oldDate = target.activeDate || '';
  let history = target.history || '';
  if (oldDate) {
    const dtOld = new Date(oldDate + 'T00:00:00+08:00');
    const dtNew = new Date(replaceDate + 'T00:00:00+08:00');
    let entry = oldDate;
    if (!isNaN(dtOld.getTime()) && !isNaN(dtNew.getTime())) {
      const usedDays = Math.max(0, Math.round((dtNew.getTime() - dtOld.getTime()) / (1000 * 60 * 60 * 24)));
      entry = oldDate + '(用' + usedDays + '天)';
    }
    history = history ? (history + ' | ' + entry) : entry;
  }

  const newModel = data.newModel ? String(data.newModel).trim() : (target.model || '');
  const newCode = data.newPairingCode ? String(data.newPairingCode).trim() : (target.pairingCode || '');

  await updateDoc(ref, {
    pairingCode: newCode,
    model: newModel,
    activeDate: replaceDate,
    history
  });

  return { _message: '已記錄更換新燈泡並歸檔舊壽命', deviceId, history };
}

async function handleHomekitDeleteDevice(user, data) {
  const deviceId = String(data.deviceId || '').trim();
  const ref = doc(db, COLS.HOMEKIT, deviceId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該 HomeKit 設備');
  await deleteDoc(ref);
  return { _message: '已刪除設備', deviceId };
}

// ==================== 4. 公費結算核心引擎與 Handlers ====================

async function recalculateMonthSettlements(monthStr) {
  const [expSnap, setSnap, config, accounts] = await Promise.all([
    getDocs(query(collection(db, COLS.EXPENSES), where('month', '==', monthStr))),
    getDocs(query(collection(db, COLS.SETTLEMENTS), where('month', '==', monthStr))),
    getSystemConfigMap(),
    getAllDocs(COLS.ACCOUNTS)
  ]);

  if (setSnap.empty) return;

  const expenses = expSnap.docs.map(d => d.data());
  const settlements = setSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
  const rentPayerUserId = await getRentPayerUserId(config, accounts);

  let totalShared = 0;
  let totalElec = 0;
  const advById = {};
  const advByName = {};

  expenses.forEach(e => {
    const amt = parseNumber(e.amount);
    if (e.category === '電費') totalElec += amt;
    else totalShared += amt;

    if (e.paidByUserId) {
      advById[e.paidByUserId] = (advById[e.paidByUserId] || 0) + amt;
    } else if (e.paidByName) {
      advByName[e.paidByName] = (advByName[e.paidByName] || 0) + amt;
    }
  });

  let sumDays = 0;
  let sumElecDays = 0;
  let totalMonthRent = 0;
  settlements.forEach(s => {
    totalMonthRent += parseNumber(s.rent);
    sumDays += parseNumber(s.sharedDays);
    sumElecDays += parseNumber(s.elecDays);
  });

  const nowStr = formatNow();
  const batch = writeBatch(db);

  settlements.forEach(s => {
    const rent = parseNumber(s.rent);
    const sharedDays = parseNumber(s.sharedDays);
    const elecDays = parseNumber(s.elecDays);

    const rawShareCost = sumDays > 0 ? totalShared * (sharedDays / sumDays) : 0;
    const rawElecCost = sumElecDays > 0 ? totalElec * (elecDays / sumElecDays) : 0;
    const advanced = (advById[s.userId] || 0) + (advByName[s.memberName] || 0);
    const isRentPayer = Boolean(rentPayerUserId && s.userId === rentPayerUserId);
    const rentAdvanced = isRentPayer ? totalMonthRent : 0;
    const finalAmount = Math.round(rent + rawShareCost + rawElecCost - advanced - rentAdvanced);

    batch.update(doc(db, COLS.SETTLEMENTS, s._id), {
      shareCost: Math.round(rawShareCost),
      elecCost: Math.round(rawElecCost),
      advanced,
      finalAmount,
      updatedAt: nowStr
    });
  });

  await batch.commit();
}

async function syncCurrentMonthRentIfUnsettled(monthStr) {
  const mSnap = await getDocs(query(collection(db, COLS.SETTLEMENTS), where('month', '==', monthStr)));
  if (mSnap.empty) {
    return { synced: false, reason: 'MONTH_NOT_FOUND' };
  }

  const mRows = mSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
  const hasLocked = mRows.some(s => s.paymentStatus !== '未結算' && s.paymentStatus !== '收款人');
  if (hasLocked) {
    return { synced: false, reason: 'MONTH_ALREADY_SETTLED_OR_PAID' };
  }

  const [rentPreview, accounts] = await Promise.all([
    calculateRentPreview(),
    getAllDocs(COLS.ACCOUNTS)
  ]);

  const nowStr = formatNow();
  const batch = writeBatch(db);

  mRows.forEach(s => {
    const acc = accounts.find(a => a.userId === s.userId);
    if (!acc) return;
    let newRent = 0;
    if (acc.status === '啟用') {
      const rm = rentPreview.rooms.find(r => r.roomId === acc.roomId);
      newRent = rm ? rm.perPersonRent : 0;
    }
    batch.update(doc(db, COLS.SETTLEMENTS, s._id), {
      memberName: acc.displayName,
      rent: newRent,
      updatedAt: nowStr
    });
  });

  await batch.commit();
  await recalculateMonthSettlements(monthStr);
  return { synced: true, month: monthStr };
}

async function buildMonthPayload(monthStr) {
  const [allSettlements, accounts, config] = await Promise.all([
    getAllDocs(COLS.SETTLEMENTS),
    getAllDocs(COLS.ACCOUNTS),
    getSystemConfigMap()
  ]);

  const availableMonths = Array.from(new Set(allSettlements.map(s => s.month).filter(Boolean)))
    .sort()
    .reverse();

  const targetMonth = monthStr || availableMonths[0] || '';
  const accMap = {};
  accounts.forEach(a => { accMap[a.userId] = a; });

  const rentPayerUserId = await getRentPayerUserId(config, accounts);
  const expensePresets = await getExpensePresets(config);

  const activeMembers = accounts
    .filter(a => a.status === '啟用' || a.status === '待結電費')
    .sort((a, b) => parseNumber(a.sortOrder) - parseNumber(b.sortOrder))
    .map(a => ({
      userId: a.userId,
      displayName: a.displayName,
      status: a.status
    }));

  if (!targetMonth) {
    return {
      availableMonths: [],
      month: '',
      settlementDate: '-',
      rentPayerUserId,
      expensePresets,
      summary: { totalShared: 0, totalElec: 0, totalDays: 0, totalElecDays: 0, totalRent: 0 },
      expenses: [],
      settlements: [],
      activeMembers
    };
  }

  const expSnap = await getDocs(query(collection(db, COLS.EXPENSES), where('month', '==', targetMonth)));
  const expenses = expSnap.docs
    .map(d => {
      const e = d.data();
      return {
        id: e.id || d.id,
        month: e.month,
        date: e.date || '',
        category: e.category || '一般公費',
        item: e.item || '',
        amount: parseNumber(e.amount),
        paidByUserId: e.paidByUserId || '',
        paidByName: e.paidByName || '',
        note: e.note || '',
        pushed: parseBool(e.pushed),
        createdById: e.createdById || ''
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  let totalShared = 0;
  let totalElec = 0;
  expenses.forEach(e => {
    if (e.category === '電費') totalElec += e.amount;
    else totalShared += e.amount;
  });

  const targetRows = allSettlements.filter(s => s.month === targetMonth);
  let totalDays = 0;
  let totalElecDays = 0;
  let totalRent = 0;
  targetRows.forEach(s => {
    totalRent += parseNumber(s.rent);
    totalDays += parseNumber(s.sharedDays);
    totalElecDays += parseNumber(s.elecDays);
  });

  const settlements = targetRows
    .map(s => {
      const acc = accMap[s.userId];
      const rent = parseNumber(s.rent);
      const isRentPayer = Boolean(rentPayerUserId && s.userId === rentPayerUserId);

      return {
        settlementId: s.settlementId || s._id,
        userId: s.userId,
        memberName: s.memberName,
        accountStatus: acc ? acc.status : '停用',
        sortOrder: acc ? parseNumber(acc.sortOrder) : 999,
        isRentPayer,
        rent,
        rentAdvanced: isRentPayer ? totalRent : 0,
        sharedDays: parseNumber(s.sharedDays),
        elecDays: parseNumber(s.elecDays),
        shareCost: parseNumber(s.shareCost),
        elecCost: parseNumber(s.elecCost),
        advanced: parseNumber(s.advanced),
        finalAmount: parseNumber(s.finalAmount),
        paymentStatus: s.paymentStatus || '未結算',
        updatedAt: s.updatedAt || ''
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    availableMonths,
    month: targetMonth,
    settlementDate: getSettlementDateStr(targetMonth),
    rentPayerUserId,
    expensePresets,
    summary: { totalShared, totalElec, totalDays, totalElecDays, totalRent },
    expenses,
    settlements,
    activeMembers
  };
}

async function handleFinanceGetMonthData(user, data) {
  const month = String(data.month || '').trim();
  return await buildMonthPayload(month);
}

async function handleFinanceSaveExpensePresets(user, data) {
  if (!Array.isArray(data.presets)) {
    throwApiError('VALIDATION_ERROR', '常用項目格式錯誤');
  }
  const updated = await saveExpensePresets(data.presets);
  return { _message: '常用支出選單已更新', expensePresets: updated };
}

async function handleFinanceInitMonth(user, data) {
  const month = String(data.month || '').trim();
  if (!/^\d{4}\.\d{2}$/.test(month)) {
    throwApiError('VALIDATION_ERROR', '月份格式須為 YYYY.MM（例如 2026.12）');
  }

  const existingSnap = await getDocs(query(collection(db, COLS.SETTLEMENTS), where('month', '==', month)));
  if (!existingSnap.empty) {
    throwApiError('CONFLICT', formatMonthZh(month) + ' 已經開立過了');
  }

  const [rentPreview, allAccounts] = await Promise.all([
    calculateRentPreview(),
    getAllDocs(COLS.ACCOUNTS)
  ]);

  const accounts = allAccounts
    .filter(a => a.status === '啟用' || a.status === '待結電費')
    .sort((a, b) => parseNumber(a.sortOrder) - parseNumber(b.sortOrder));

  if (accounts.length === 0) {
    throwApiError('VALIDATION_ERROR', '目前沒有任何啟用或待結電費的成員');
  }

  const nowStr = formatNow();
  const batch = writeBatch(db);

  accounts.forEach(acc => {
    const isPendingElec = acc.status === '待結電費';
    const rm = rentPreview.rooms.find(r => r.roomId === acc.roomId);
    const rent = (!isPendingElec && rm) ? rm.perPersonRent : 0;
    const sharedDays = isPendingElec ? 0 : (parseNumber(acc.defaultDays) || 30);
    const elecDays = isPendingElec ? 0 : (parseNumber(acc.defaultDays) || 30);
    const settlementId = month + '_' + acc.userId;

    batch.set(doc(db, COLS.SETTLEMENTS, settlementId), {
      settlementId,
      month,
      userId: acc.userId,
      memberName: acc.displayName,
      rent,
      sharedDays,
      elecDays,
      shareCost: 0,
      elecCost: 0,
      advanced: 0,
      finalAmount: rent,
      paymentStatus: '未結算',
      updatedAt: nowStr
    });
  });

  await batch.commit();

  let importedCount = 0;
  if (data.importTemplates) {
    importedCount = await importTemplatesForMonth(user, month);
  }

  await recalculateMonthSettlements(month);
  const payload = await buildMonthPayload(month);

  return {
    _message: '已開立 ' + formatMonthZh(month) + ' 帳務' + (importedCount > 0 ? '並匯入 ' + importedCount + ' 筆固定支出' : ''),
    ...payload,
    warnings: rentPreview.warnings
  };
}

async function importTemplatesForMonth(user, month) {
  const templates = (await getAllDocs(COLS.TEMPLATES)).filter(t => parseBool(t.enabled));
  if (templates.length === 0) return 0;

  const dateStr = month.replace('.', '-') + '-01';
  const batch = writeBatch(db);

  templates.forEach(t => {
    const id = genId('EXP');
    batch.set(doc(db, COLS.EXPENSES, id), {
      id,
      month,
      date: dateStr,
      category: t.category === '電費' ? '電費' : '一般公費',
      item: t.item,
      amount: parseNumber(t.defaultAmount),
      paidByUserId: t.defaultPaidByUserId || '',
      paidByName: t.defaultPaidByName || '',
      note: '固定支出匯入',
      pushed: false,
      createdById: user.userId
    });
  });

  await batch.commit();
  return templates.length;
}

async function handleFinanceImportTemplates(user, data) {
  const month = String(data.month || '').trim();
  if (!month) throwApiError('VALIDATION_ERROR', '缺少月份參數');

  const count = await importTemplatesForMonth(user, month);
  await recalculateMonthSettlements(month);
  const payload = await buildMonthPayload(month);

  return {
    _message: count > 0 ? ('已匯入 ' + count + ' 筆固定支出') : '目前沒有啟用中的固定支出模板',
    importedCount: count,
    ...payload
  };
}

async function createExpenseInternal(user, data) {
  const month = String(data.month || '').trim();
  const date = String(data.date || formatNow('yyyy-MM-dd')).trim();
  const category = data.category === '電費' ? '電費' : '一般公費';
  const item = String(data.item || '').trim();
  const amount = parseNumber(data.amount);
  const paidByUserId = String(data.paidByUserId || '').trim();
  const note = String(data.note || '').trim();
  const notifyPush = Boolean(data.notifyPush);

  if (!month || !item || amount <= 0) {
    throwApiError('VALIDATION_ERROR', '月份、項目名稱不可為空，且金額必須大於 0');
  }

  let paidByName = '';
  if (paidByUserId) {
    const accSnap = await getDoc(doc(db, COLS.ACCOUNTS, paidByUserId));
    paidByName = accSnap.exists() ? (accSnap.data().displayName || '') : '';
  }

  const id = genId('EXP');
  await setDoc(doc(db, COLS.EXPENSES, id), {
    id,
    month,
    date,
    category,
    item,
    amount,
    paidByUserId,
    paidByName,
    note,
    pushed: notifyPush,
    createdById: user.userId
  });

  if (data.saveToPresets) {
    await addExpensePreset(item);
  }

  await recalculateMonthSettlements(month);

  if (notifyPush) {
    await sendOneSignalPush({
      title: '💸 新增' + category + '（' + formatMonthZh(month) + '）',
      message: item + '：' + amount.toLocaleString() + ' 元' + (paidByName ? '（代墊：' + paidByName + '）' : ''),
      path: '/finance.html'
    });
  }

  return { id, month, date, category, item, amount, paidByUserId, paidByName, note };
}

async function handleFinanceAddExpense(user, data) {
  const exp = await createExpenseInternal(user, data);
  const payload = await buildMonthPayload(exp.month);
  return {
    _message: data.saveToPresets ? '已新增支出並加入常用選單' : '已新增支出項目',
    expense: exp,
    ...payload
  };
}

async function handleFinanceUpdateExpense(user, data) {
  const id = String(data.id || '').trim();
  if (!id) throwApiError('VALIDATION_ERROR', '缺少支出 ID');

  const ref = doc(db, COLS.EXPENSES, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該筆支出明細');
  const target = snap.data();

  if (user.role !== 'Admin' && target.createdById !== user.userId) {
    throwApiError('FORBIDDEN', '您只能修改自己建立的支出項目');
  }

  const oldMonth = target.month;
  const newMonth = data.month ? String(data.month).trim() : oldMonth;
  const date = data.date ? String(data.date).trim() : target.date;
  const category = data.category ? (data.category === '電費' ? '電費' : '一般公費') : target.category;
  const item = data.item !== undefined ? String(data.item).trim() : target.item;
  const amount = data.amount !== undefined ? parseNumber(data.amount) : parseNumber(target.amount);
  const paidByUserId = data.paidByUserId !== undefined ? String(data.paidByUserId).trim() : (target.paidByUserId || '');
  const note = data.note !== undefined ? String(data.note).trim() : (target.note || '');

  if (!item || amount <= 0) {
    throwApiError('VALIDATION_ERROR', '項目名稱不可為空，且金額必須大於 0');
  }

  let paidByName = '';
  if (paidByUserId) {
    const accSnap = await getDoc(doc(db, COLS.ACCOUNTS, paidByUserId));
    paidByName = accSnap.exists() ? (accSnap.data().displayName || '') : (target.paidByName || '');
  }

  await updateDoc(ref, {
    month: newMonth,
    date,
    category,
    item,
    amount,
    paidByUserId,
    paidByName,
    note
  });

  if (data.saveToPresets) {
    await addExpensePreset(item);
  }

  await recalculateMonthSettlements(oldMonth);
  if (newMonth !== oldMonth) await recalculateMonthSettlements(newMonth);

  const payload = await buildMonthPayload(newMonth);
  return {
    _message: data.saveToPresets ? '支出已更新並加入常用選單' : '支出項目已更新',
    ...payload
  };
}

async function handleFinanceDeleteExpense(user, data) {
  const id = String(data.id || '').trim();
  const ref = doc(db, COLS.EXPENSES, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該筆支出明細');
  const target = snap.data();

  if (user.role !== 'Admin' && target.createdById !== user.userId) {
    throwApiError('FORBIDDEN', '您只能刪除自己建立的支出項目');
  }

  const month = target.month;
  await deleteDoc(ref);
  await recalculateMonthSettlements(month);

  const payload = await buildMonthPayload(month);
  return { _message: '已刪除支出項目', ...payload };
}

async function handleFinanceUpdateMemberMonth(user, data) {
  const settlementId = String(data.settlementId || '').trim();
  const ref = doc(db, COLS.SETTLEMENTS, settlementId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該成員的月份結算紀錄');
  const target = snap.data();

  const rent = data.rent !== undefined ? parseNumber(data.rent) : parseNumber(target.rent);
  const sharedDays = data.sharedDays !== undefined ? parseNumber(data.sharedDays) : parseNumber(target.sharedDays);
  const elecDays = data.elecDays !== undefined ? parseNumber(data.elecDays) : parseNumber(target.elecDays);

  if (rent < 0 || sharedDays < 0 || elecDays < 0) {
    throwApiError('VALIDATION_ERROR', '房租與天數不可為負數');
  }

  await updateDoc(ref, {
    rent,
    sharedDays,
    elecDays,
    updatedAt: formatNow()
  });

  await recalculateMonthSettlements(target.month);
  const payload = await buildMonthPayload(target.month);
  return { _message: '已更新該成員本月房租與天數', ...payload };
}

async function handleFinanceTogglePaymentStatus(user, data) {
  const settlementId = String(data.settlementId || '').trim();
  const newStatus = String(data.paymentStatus || '').trim();
  const allowed = ['未結算', '待繳款', '已繳清', '待退款', '收款人'];

  if (!allowed.includes(newStatus)) {
    throwApiError('VALIDATION_ERROR', '無效的對帳狀態');
  }

  const ref = doc(db, COLS.SETTLEMENTS, settlementId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該筆結算紀錄');
  const target = snap.data();

  await updateDoc(ref, {
    paymentStatus: newStatus,
    updatedAt: formatNow()
  });

  if (newStatus === '已繳清' && data.notifyMember !== false && target.userId !== user.userId) {
    const monthZh = formatMonthZh(target.month);
    await sendOneSignalPush({
      title: '✅ 對帳完成通知（' + monthZh + '）',
      message: '管理員已確認您的 ' + monthZh + ' 帳務已結清，感謝配合！',
      userIds: [target.userId],
      path: '/finance.html'
    });
  }

  const payload = await buildMonthPayload(target.month);
  return { _message: '已更新對帳狀態為「' + newStatus + '」', ...payload };
}

async function handleFinanceSendSettlementNotify(user, data) {
  const month = String(data.month || '').trim();
  if (!month) throwApiError('VALIDATION_ERROR', '缺少結算月份');

  await recalculateMonthSettlements(month);
  const [snap, rentPayerUserId] = await Promise.all([
    getDocs(query(collection(db, COLS.SETTLEMENTS), where('month', '==', month))),
    getRentPayerUserId()
  ]);

  if (snap.empty) throwApiError('NOT_FOUND', '查無 ' + formatMonthZh(month) + ' 結算資料');

  const nowStr = formatNow();
  const targetUserIds = [];
  const batch = writeBatch(db);
  let hasUpdates = false;

  snap.docs.forEach(d => {
    const s = d.data();
    targetUserIds.push(s.userId);
    const amt = parseNumber(s.finalAmount);
    const isRentPayer = Boolean(rentPayerUserId && s.userId === rentPayerUserId);

    if (s.paymentStatus === '未結算') {
      const nextStatus = isRentPayer
        ? '收款人'
        : (amt < 0 ? '待退款' : (amt === 0 ? '已繳清' : '待繳款'));
      batch.update(doc(db, COLS.SETTLEMENTS, d.id), {
        paymentStatus: nextStatus,
        updatedAt: nowStr
      });
      hasUpdates = true;
    }
  });

  if (hasUpdates) await batch.commit();

  const payload = await buildMonthPayload(month);
  const summaryLines = payload.settlements.map(m => {
    const label = m.finalAmount < 0
      ? ((m.isRentPayer ? '應收 ' : '應退 ') + Math.abs(m.finalAmount).toLocaleString())
      : ('應繳 ' + m.finalAmount.toLocaleString());
    return m.memberName + ' ' + label;
  }).join('｜');

  const pushResult = await sendOneSignalPush({
    title: '📊 ' + formatMonthZh(month) + ' 公費與房租已結算',
    message: summaryLines + '（點此查看明細）',
    userIds: targetUserIds,
    path: '/finance.html'
  });

  return {
    _message: '已結算並發送推播通知',
    pushResult,
    ...payload
  };
}

async function handleFinanceSendPaymentReminder(user, data) {
  const settlementId = String(data.settlementId || '').trim();
  const snap = await getDoc(doc(db, COLS.SETTLEMENTS, settlementId));
  if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該筆結算紀錄');
  const target = snap.data();

  const amt = parseNumber(target.finalAmount);
  const pushResult = await sendOneSignalPush({
    title: '⏰ ' + formatMonthZh(target.month) + ' 公費繳款提醒',
    message: '提醒您本月應繳金額為 ' + amt.toLocaleString() + ' 元，轉帳完成後管理員將為您勾選對帳。',
    userIds: [target.userId],
    path: '/finance.html'
  });

  return {
    _message: '已發送個別繳費提醒給 ' + target.memberName,
    pushResult
  };
}

// ==================== 5. 系統設定、房租比例與帳號管理 Handlers ====================

async function handleSettingsGetAll() {
  const [config, accountsRaw, templatesRaw, roomsRaw] = await Promise.all([
    getSystemConfigMap(),
    getAllDocs(COLS.ACCOUNTS),
    getAllDocs(COLS.TEMPLATES),
    getAllDocs(COLS.ROOMS)
  ]);

  const rentPreview = await calculateRentPreview(parseNumber(config.TOTAL_RENT), roomsRaw, accountsRaw);
  const rentPayerUserId = await getRentPayerUserId(config, accountsRaw);

  const accounts = accountsRaw
    .map(a => {
      const rm = rentPreview.rooms.find(r => r.roomId === a.roomId);
      const estimatedRent = (a.status === '啟用' && rm) ? rm.perPersonRent : 0;
      return {
        userId: a.userId,
        displayName: a.displayName,
        username: a.username,
        role: a.role,
        roomId: a.roomId || '',
        defaultDays: parseNumber(a.defaultDays) || 30,
        status: a.status,
        mustResetPassword: parseBool(a.mustResetPassword),
        sortOrder: parseNumber(a.sortOrder),
        lastLoginAt: a.lastLoginAt || '',
        estimatedRent
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const templates = templatesRaw.map(t => ({
    templateId: t.templateId || t._id,
    category: t.category || '一般公費',
    item: t.item || '',
    defaultAmount: parseNumber(t.defaultAmount),
    defaultPaidByUserId: t.defaultPaidByUserId || '',
    defaultPaidByName: t.defaultPaidByName || '',
    enabled: parseBool(t.enabled)
  }));

  return {
    rentPreview,
    accounts,
    templates,
    systemConfig: {
      totalRent: parseNumber(config.TOTAL_RENT),
      notifyOnExpense: parseBool(config.NOTIFY_ON_EXPENSE),
      notifyOnAnnouncement: parseBool(config.NOTIFY_ON_ANNOUNCEMENT),
      autoSettleDay: config.AUTO_SETTLE_DAY || 'LAST',
      autoSettleTime: config.AUTO_SETTLE_TIME || '20:00',
      appUrl: config.APP_URL || '',
      rentPayerUserId
    }
  };
}

async function handleSettingsSaveRentAndRooms(user, data) {
  const totalRent = parseNumber(data.totalRent);
  if (totalRent <= 0) throwApiError('VALIDATION_ERROR', '總房租必須大於 0');

  const rooms = data.rooms;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throwApiError('VALIDATION_ERROR', '至少需有一間房間設定');
  }

  rooms.forEach(r => {
    if (!r.roomId || !r.name || parseNumber(r.weight) <= 0) {
      throwApiError('VALIDATION_ERROR', '房間名稱與比例權重必須為有效正數');
    }
  });

  const existingRooms = await getAllDocs(COLS.ROOMS);
  const newIds = new Set(rooms.map(r => String(r.roomId).trim()));
  const batch = writeBatch(db);

  batch.set(doc(db, COLS.CONFIG, 'TOTAL_RENT'), {
    key: 'TOTAL_RENT',
    value: String(totalRent)
  }, { merge: true });

  existingRooms.forEach(old => {
    if (!newIds.has(old._id)) {
      batch.delete(doc(db, COLS.ROOMS, old._id));
    }
  });

  rooms.forEach(r => {
    const roomId = String(r.roomId).trim();
    batch.set(doc(db, COLS.ROOMS, roomId), {
      roomId,
      name: String(r.name).trim(),
      weight: parseNumber(r.weight)
    });
  });

  await batch.commit();

  let syncInfo = null;
  if (data.syncCurrentMonth) {
    syncInfo = await syncCurrentMonthRentIfUnsettled(String(data.syncCurrentMonth).trim());
  }

  return {
    _message: '總房租與房間比例已儲存',
    rentPreview: await calculateRentPreview(),
    syncInfo
  };
}

async function handleSettingsSaveAccount(adminUser, data) {
  const mode = data.mode === 'create' ? 'create' : 'update';
  const displayName = String(data.displayName || '').trim();
  const username = String(data.username || '').trim();
  const role = data.role === 'Admin' ? 'Admin' : 'Member';
  const roomId = String(data.roomId || '').trim();
  const defaultDays = parseNumber(data.defaultDays) || 30;
  const status = ['啟用', '待結電費', '停用'].includes(data.status) ? data.status : '啟用';
  const sortOrder = parseNumber(data.sortOrder) || 99;

  if (!displayName || !username) {
    throwApiError('VALIDATION_ERROR', '顯示名稱與登入帳號為必填');
  }

  const [accounts, secret] = await Promise.all([
    getAllDocs(COLS.ACCOUNTS),
    getAuthSecret()
  ]);

  let tempPassword = null;
  let savedUserId = '';

  if (mode === 'create') {
    const dup = accounts.find(a => String(a.username || '').toLowerCase() === username.toLowerCase());
    if (dup) throwApiError('CONFLICT', '登入帳號「' + username + '」已存在');

    let maxNum = 0;
    accounts.forEach(a => {
      const m = String(a.userId || '').match(/^USR_(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    savedUserId = 'USR_' + String(maxNum + 1).padStart(2, '0');

    const plainPwd = String(data.password || '').trim() || generateTempPin();
    if (!data.password) tempPassword = plainPwd;
    const mustReset = data.mustResetPassword !== undefined ? Boolean(data.mustResetPassword) : true;

    await setDoc(doc(db, COLS.ACCOUNTS, savedUserId), {
      userId: savedUserId,
      displayName,
      username,
      passwordHash: await hashPassword(plainPwd, secret),
      role,
      roomId,
      defaultDays,
      status,
      mustResetPassword: mustReset,
      sortOrder,
      lastLoginAt: ''
    });
  } else {
    savedUserId = String(data.userId || '').trim();
    const target = accounts.find(a => a.userId === savedUserId);
    if (!target) throwApiError('NOT_FOUND', '找不到目標成員');

    const dup = accounts.find(a => a.userId !== savedUserId && String(a.username || '').toLowerCase() === username.toLowerCase());
    if (dup) throwApiError('CONFLICT', '登入帳號「' + username + '」已被其他人使用');

    if (target.role === 'Admin' && (role !== 'Admin' || status !== '啟用')) {
      const otherAdmins = accounts.filter(a => a.userId !== savedUserId && a.role === 'Admin' && a.status === '啟用');
      if (otherAdmins.length === 0) {
        throwApiError('CONFLICT', '系統至少必須保留一位啟用中的管理員');
      }
    }

    const passwordHash = data.password
      ? await hashPassword(String(data.password).trim(), secret)
      : target.passwordHash;
    const mustResetPassword = data.mustResetPassword !== undefined
      ? Boolean(data.mustResetPassword)
      : parseBool(target.mustResetPassword);

    await updateDoc(doc(db, COLS.ACCOUNTS, savedUserId), {
      displayName,
      username,
      passwordHash,
      role,
      roomId,
      defaultDays,
      status,
      mustResetPassword,
      sortOrder
    });
  }

  let syncInfo = null;
  if (data.syncCurrentMonth) {
    syncInfo = await syncCurrentMonthRentIfUnsettled(String(data.syncCurrentMonth).trim());
  }

  return {
    _message: mode === 'create' ? '已建立新成員帳號' : '成員資料已更新',
    userId: savedUserId,
    tempPassword,
    rentPreview: await calculateRentPreview(),
    syncInfo
  };
}

async function handleSettingsSaveTemplate(user, data) {
  const category = data.category === '電費' ? '電費' : '一般公費';
  const item = String(data.item || '').trim();
  const defaultAmount = parseNumber(data.defaultAmount);
  const defaultPaidByUserId = String(data.defaultPaidByUserId || '').trim();
  const enabled = data.enabled !== undefined ? Boolean(data.enabled) : true;

  if (!data.delete && !item) throwApiError('VALIDATION_ERROR', '模板項目名稱不可為空');

  let defaultPaidByName = '';
  if (defaultPaidByUserId) {
    const accSnap = await getDoc(doc(db, COLS.ACCOUNTS, defaultPaidByUserId));
    defaultPaidByName = accSnap.exists() ? (accSnap.data().displayName || '') : '';
  }

  if (data.templateId) {
    const ref = doc(db, COLS.TEMPLATES, data.templateId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throwApiError('NOT_FOUND', '找不到該固定支出模板');
    if (data.delete) {
      await deleteDoc(ref);
      return { _message: '已刪除模板', templateId: data.templateId };
    }
    await updateDoc(ref, {
      category,
      item,
      defaultAmount,
      defaultPaidByUserId,
      defaultPaidByName,
      enabled
    });
    return { _message: '固定支出模板已更新', templateId: data.templateId };
  } else {
    const newId = genId('TPL');
    await setDoc(doc(db, COLS.TEMPLATES, newId), {
      templateId: newId,
      category,
      item,
      defaultAmount,
      defaultPaidByUserId,
      defaultPaidByName,
      enabled
    });
    return { _message: '已新增固定支出模板', templateId: newId };
  }
}

async function handleSettingsSaveSystemConfig(user, data) {
  const batch = writeBatch(db);
  const put = (key, value, desc) => {
    const obj = { key, value: String(value) };
    if (desc !== undefined) obj.desc = desc;
    batch.set(doc(db, COLS.CONFIG, key), obj, { merge: true });
  };

  if (data.notifyOnExpense !== undefined) {
    put('NOTIFY_ON_EXPENSE', data.notifyOnExpense ? 'TRUE' : 'FALSE');
  }
  if (data.notifyOnAnnouncement !== undefined) {
    put('NOTIFY_ON_ANNOUNCEMENT', data.notifyOnAnnouncement ? 'TRUE' : 'FALSE');
  }
  if (data.autoSettleDay !== undefined) {
    put('AUTO_SETTLE_DAY', String(data.autoSettleDay).trim() || 'LAST');
  }
  if (data.autoSettleTime !== undefined) {
    put('AUTO_SETTLE_TIME', String(data.autoSettleTime).trim() || '20:00');
  }
  if (data.appUrl !== undefined) {
    put('APP_URL', String(data.appUrl).trim().replace(/\/$/, ''));
  }
  if (data.rentPayerUserId !== undefined) {
    put('RENT_PAYER_USER_ID', String(data.rentPayerUserId).trim(), '整戶房租代墊人成員ID');
  }

  await batch.commit();
  return { _message: '系統推播與排程設定已儲存' };
}

// ==================== 統一路由分發器（對齊原 GAS 32 支 Action） ====================

const ROUTE_TABLE = {
  // 驗證模組
  'auth.login':                   { level: 'Public',  fn: (u, d) => handleAuthLogin(d) },
  'auth.verify':                  { level: 'AllRead', fn: (u, d) => handleAuthVerify(u) },
  'auth.changePassword':          { level: 'Member+', fn: (u, d) => handleAuthChangePassword(u, d) },
  'auth.resetPassword':           { level: 'Admin',   fn: (u, d) => handleAuthResetPassword(u, d) },

  // 首頁與公告
  'dashboard.getSummary':         { level: 'AllRead', fn: (u, d) => handleDashboardGetSummary(u) },
  'announcement.list':            { level: 'Member+', fn: (u, d) => handleAnnouncementList(u, d) },
  'announcement.create':          { level: 'Member+', fn: (u, d) => handleAnnouncementCreate(u, d) },
  'announcement.update':          { level: 'Member+', fn: (u, d) => handleAnnouncementUpdate(u, d) },

  // 公費結算模組
  'finance.getMonthData':         { level: 'AllRead', fn: (u, d) => handleFinanceGetMonthData(u, d) },
  'finance.initMonth':            { level: 'Admin',   fn: (u, d) => handleFinanceInitMonth(u, d) },
  'finance.importTemplates':      { level: 'Admin',   fn: (u, d) => handleFinanceImportTemplates(u, d) },
  'finance.addExpense':           { level: 'Member+', fn: (u, d) => handleFinanceAddExpense(u, d) },
  'finance.updateExpense':        { level: 'Member+', fn: (u, d) => handleFinanceUpdateExpense(u, d) },
  'finance.deleteExpense':        { level: 'Member+', fn: (u, d) => handleFinanceDeleteExpense(u, d) },
  'finance.saveExpensePresets':   { level: 'Admin',   fn: (u, d) => handleFinanceSaveExpensePresets(u, d) },
  'finance.updateMemberMonth':    { level: 'Admin',   fn: (u, d) => handleFinanceUpdateMemberMonth(u, d) },
  'finance.togglePaymentStatus':  { level: 'Admin',   fn: (u, d) => handleFinanceTogglePaymentStatus(u, d) },
  'finance.sendSettlementNotify': { level: 'Admin',   fn: (u, d) => handleFinanceSendSettlementNotify(u, d) },
  'finance.sendPaymentReminder':  { level: 'Admin',   fn: (u, d) => handleFinanceSendPaymentReminder(u, d) },

  // 居家瓦斯與 HomeKit
  'home.getSummary':              { level: 'Member+', fn: (u, d) => handleHomeGetSummary(u) },
  'gas.getStatusAndLogs':         { level: 'Member+', fn: (u, d) => handleGasGetStatusAndLogs(u) },
  'gas.switchBackup':             { level: 'Member+', fn: (u, d) => handleGasSwitchBackup(u, d) },
  'gas.refillFull':               { level: 'Member+', fn: (u, d) => handleGasRefillFull(u, d) },
  'homekit.list':                 { level: 'Member+', fn: (u, d) => handleHomekitList(u) },
  'homekit.saveDevice':           { level: 'Member+', fn: (u, d) => handleHomekitSaveDevice(u, d) },
  'homekit.replaceBulb':          { level: 'Member+', fn: (u, d) => handleHomekitReplaceBulb(u, d) },
  'homekit.deleteDevice':         { level: 'Admin',   fn: (u, d) => handleHomekitDeleteDevice(u, d) },

  // 系統設定與帳號房租管理
  'settings.getAll':              { level: 'Admin',   fn: (u, d) => handleSettingsGetAll(u) },
  'settings.saveRentAndRooms':    { level: 'Admin',   fn: (u, d) => handleSettingsSaveRentAndRooms(u, d) },
  'settings.saveAccount':         { level: 'Admin',   fn: (u, d) => handleSettingsSaveAccount(u, d) },
  'settings.saveTemplate':        { level: 'Admin',   fn: (u, d) => handleSettingsSaveTemplate(u, d) },
  'settings.saveSystemConfig':    { level: 'Admin',   fn: (u, d) => handleSettingsSaveSystemConfig(u, d) }
};

export async function dispatchApi(action, token = '', data = {}) {
  try {
    await ensureInitialized();

    const route = ROUTE_TABLE[String(action || '').trim()];
    if (!route) {
      throwApiError('NOT_FOUND', '不支援的 API action：' + action);
    }

    let user = null;
    if (route.level !== 'Public') {
      user = await authenticateRequest(token, route.level);
    }

    const result = await route.fn(user, data || {});
    const message = (result && result._message) ? result._message : '操作成功';
    if (result && result._message !== undefined) {
      delete result._message;
    }

    const authMeta = (user && action !== 'auth.verify')
      ? await buildAuthEnvelope(user)
      : null;

    const body = {
      ok: true,
      code: 'OK',
      message,
      data: result !== undefined ? result : null,
      timestamp: formatNow("yyyy-MM-dd'T'HH:mm:ss+08:00")
    };
    if (authMeta) body._auth = authMeta;
    return body;
  } catch (err) {
    const code = err.apiCode || 'INTERNAL_ERROR';
    let msg = err.message || '伺服器發生未預期錯誤';
    if (err.code === 'permission-denied') {
      msg = 'Firestore 權限遭拒，請確認 Firebase Console 的安全性規則已發布';
    }
    console.error('Firebase Backend Error [' + code + ']:', err);
    return {
      ok: false,
      code,
      message: msg,
      data: null,
      timestamp: formatNow("yyyy-MM-dd'T'HH:mm:ss+08:00")
    };
  }
}
