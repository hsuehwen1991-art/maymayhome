/**
 * MayMayHome 前端共用核心引擎 v2.0
 * 負責：
 * - Firebase Firestore 後端動態載入與 API 通訊層
 * - 冷啟動 3 秒貓咪載入動畫＋進度讀條＋背景多頁資料預載
 * - 讀寫分級同步遮罩（全頁鎖定改用貓咪奔跑動畫，局部卡片遮罩維持輕量膠囊）
 * - 頂部標題列：三態推播鈴鐺開關（灰／綠／紅斜線，與手機系統權限即時同步）＋ [i] 角色分級 Markdown 說明書
 * - 登入與強制改密彈窗、iOS Liquid Glass 導覽列與滑動動畫、OneSignal PWA 推播與前景橫幅
 */

const App = (() => {
  let backendPromise = null;
  function getBackend() {
    if (!backendPromise) {
      backendPromise = import('./firebase-backend.js');
    }
    return backendPromise;
  }

  const STORAGE = {
    TOKEN: 'mmh_token',
    USER: 'mmh_user',
    PUSH_APP_ID: 'mmh_push_app_id',
    UI_DEFAULTS: 'mmh_ui_defaults',
    PUSH_SUBSCRIBED: 'mmh_push_subscribed',
    PUSH_ENABLED: 'mmh_push_enabled',
    GUIDE_MD: 'mmh_guide_md_v2'
  };

  let currentUser = null;
  let uiDefaults = { notifyOnExpense: false, notifyOnAnnouncement: true };
  let oneSignalInitialized = false;
  let oneSignalScheduled = false;
  let onReadyCallback = null;
  let cachedGuideMd = '';
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  // ==================== 工具函式 ====================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(n) {
    return Number(n || 0).toLocaleString('zh-TW');
  }

  function formatMonth(monthStr) {
    if (!monthStr) return '';
    const m = String(monthStr).trim().match(/^(\d{4})[.\-\/](\d{1,2})$/);
    if (!m) return String(monthStr);
    return `${m[1]}年${String(m[2]).padStart(2, '0')}月`;
  }

  function getCurrentMonthStr() {
    const d = new Date();
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function getTodayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getCache(key) {
    try {
      const raw = localStorage.getItem('mmh_cache_' + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setCache(key, data) {
    try {
      localStorage.setItem('mmh_cache_' + key, JSON.stringify(data));
    } catch {}
  }

  function clearSession() {
    localStorage.removeItem(STORAGE.TOKEN);
    localStorage.removeItem(STORAGE.USER);
    currentUser = null;
  }

  function getUser() {
    if (currentUser) return currentUser;
    try {
      const raw = localStorage.getItem(STORAGE.USER);
      currentUser = raw ? JSON.parse(raw) : null;
    } catch { currentUser = null; }
    return currentUser;
  }

  function getUiDefaults() {
    try {
      const raw = localStorage.getItem(STORAGE.UI_DEFAULTS);
      if (raw) uiDefaults = JSON.parse(raw);
    } catch {}
    return uiDefaults;
  }

  function toast(message, type = 'info') {
    let container = document.getElementById('mmhToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mmhToastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  function showForegroundPushBanner(title, body, targetUrl) {
    const old = document.getElementById('mmhFgPushBanner');
    if (old) old.remove();

    const el = document.createElement('div');
    el.id = 'mmhFgPushBanner';
    el.className = 'mmh-fg-push';
    el.innerHTML = `
      <div class="mmh-fg-push-title">${escapeHtml(title || 'MayMayHome 通知')}</div>
      <div class="mmh-fg-push-body">${escapeHtml(body || '')}</div>
    `;
    el.addEventListener('click', () => {
      el.remove();
      if (targetUrl) {
        try {
          const u = new URL(targetUrl, location.origin);
          window.location.href = u.pathname + u.search + u.hash;
        } catch {
          window.location.href = targetUrl;
        }
      }
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 280);
    }, 6000);
  }

  async function copyText(text, successMsg = '已複製到剪貼簿') {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMsg, 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(successMsg, 'success');
    }
  }

  // ==================== 讀寫分級同步遮罩引擎 ====================
  const ACTION_SYNC_RULES = {
    // 靜默背景（不跳遮罩）
    'auth.verify':                  { mode: 'none' },
    'auth.login':                   { mode: 'none' },
    'notification.list':            { mode: 'none' },
    'notification.markRead':        { mode: 'none' },
    'notification.clearRead':       { mode: 'none' },
    'notification.setPushPref':     { mode: 'none' },
    'announcement.markRead':        { mode: 'none' },

    // 讀取型（卡片局部半透明遮罩，保留原小圓圈膠囊）
    'dashboard.getSummary':         { mode: 'card', text: '同步首頁資料中…' },
    'announcement.list':            { mode: 'card', text: '同步公告中…' },
    'finance.getMonthData':         { mode: 'card', text: '同步帳務明細中…' },
    'home.getSummary':              { mode: 'card', text: '同步居家設備中…' },
    'gas.getStatusAndLogs':         { mode: 'card', text: '同步瓦斯紀錄中…' },
    'homekit.list':                 { mode: 'card', text: '同步設備清單中…' },
    'settings.getAll':              { mode: 'card', text: '同步系統設定中…' },

    // 寫入與高敏感操作（全頁毛玻璃鎖定：使用貓咪奔跑動畫）
    'auth.changePassword':          { mode: 'global', text: '更新密碼中…' },
    'auth.resetPassword':           { mode: 'global', text: '重設臨時密碼中…' },
    'announcement.create':          { mode: 'global', text: '發布公告中…' },
    'announcement.update':          { mode: 'global', text: '更新公告狀態中…' },
    'account.requestDeletion':      { mode: 'global', text: '送出刪除帳號申請中…' },
    'account.cancelDeletion':       { mode: 'global', text: '取消刪除帳號申請中…' },
    'account.reviewDeletion':       { mode: 'global', text: '處理審核並發送通知中…' },
    'account.adminDelete':          { mode: 'global', text: '移除帳號並推播感謝詞中…' },
    'finance.initMonth':            { mode: 'global', text: '建立新月份帳務中…' },
    'finance.importTemplates':      { mode: 'global', text: '匯入固定支出模板中…' },
    'finance.addExpense':           { mode: 'global', text: '寫入支出並重算結算中…' },
    'finance.updateExpense':        { mode: 'global', text: '更新支出並重算結算中…' },
    'finance.deleteExpense':        { mode: 'global', text: '刪除支出並重算結算中…' },
    'finance.saveExpensePresets':   { mode: 'global', text: '儲存常用項目中…' },
    'finance.updateMemberMonth':    { mode: 'global', text: '更新天數並重算公費中…' },
    'finance.togglePaymentStatus':  { mode: 'global', text: '更新對帳狀態中…' },
    'finance.sendSettlementNotify': { mode: 'global', text: '結算帳務並推播全員中…' },
    'finance.sendPaymentReminder':  { mode: 'global', text: '發送繳款提醒推播中…' },
    'gas.switchBackup':             { mode: 'global', text: '記錄切換備用桶並通知全員中…' },
    'gas.refillFull':               { mode: 'global', text: '更新補滿紀錄中…' },
    'homekit.saveDevice':           { mode: 'global', text: '儲存設備資料中…' },
    'homekit.replaceBulb':          { mode: 'global', text: '歸檔燈泡更換紀錄中…' },
    'homekit.deleteDevice':         { mode: 'global', text: '刪除設備資料中…' },
    'settings.saveRentAndRooms':    { mode: 'global', text: '儲存房租與房間比例中…' },
    'settings.saveAccount':         { mode: 'global', text: '儲存成員帳號資料中…' },
    'settings.saveTemplate':        { mode: 'global', text: '儲存固定支出模板中…' },
    'settings.saveSystemConfig':    { mode: 'global', text: '儲存系統設定中…' }
  };

  const SyncUI = (() => {
    let globalEl = null;
    let globalCount = 0;
    let slowTimer = null;
    const globalMsgStack = [];
    const cardStateMap = new WeakMap();

    function ensureGlobalEl() {
      if (globalEl && document.body.contains(globalEl)) return globalEl;
      globalEl = document.createElement('div');
      globalEl.id = 'mmhGlobalLock';
      globalEl.className = 'mmh-global-lock';
      globalEl.setAttribute('role', 'status');
      globalEl.setAttribute('aria-live', 'polite');
      globalEl.innerHTML = `
        <div class="mmh-global-lock-card">
          <img src="assets/loading-cat.webp" alt="同步中" class="mmh-lock-cat"
               onerror="this.outerHTML='<div class=\\'mmh-spinner mmh-spinner-lg\\'></div>'">
          <div class="mmh-lock-title" id="mmhLockTitle">處理中…</div>
          <div class="mmh-lock-sub" id="mmhLockSub">同步至雲端資料庫，請勿切換頁面</div>
        </div>
      `;
      document.body.appendChild(globalEl);
      return globalEl;
    }

    function lockGlobal(text = '資料寫入中…') {
      const el = ensureGlobalEl();
      globalCount++;
      globalMsgStack.push(text);
      el.querySelector('#mmhLockTitle').textContent = text;

      if (globalCount === 1) {
        const sub = el.querySelector('#mmhLockSub');
        sub.textContent = '同步至雲端資料庫，請勿切換頁面';
        el.classList.add('open');
        clearTimeout(slowTimer);
        slowTimer = setTimeout(() => {
          if (globalCount > 0) {
            sub.textContent = '雲端連線較慢，請稍候…';
          }
        }, 4500);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        globalCount = Math.max(0, globalCount - 1);
        const idx = globalMsgStack.lastIndexOf(text);
        if (idx !== -1) globalMsgStack.splice(idx, 1);

        if (globalCount === 0) {
          clearTimeout(slowTimer);
          el.classList.remove('open');
        } else if (globalMsgStack.length > 0) {
          el.querySelector('#mmhLockTitle').textContent = globalMsgStack[globalMsgStack.length - 1];
        }
      };
    }

    function resolveElements(targets) {
      if (!targets) return [];
      if (typeof targets === 'string') return Array.from(document.querySelectorAll(targets));
      if (targets instanceof Element) return [targets];
      if (Array.isArray(targets) || targets instanceof NodeList) {
        return Array.from(targets).filter(el => el instanceof Element);
      }
      return [];
    }

    function ensureCardMask(hostEl) {
      hostEl.classList.add('mmh-sync-host');
      let mask = hostEl.querySelector(':scope > .mmh-card-mask');
      if (!mask) {
        mask = document.createElement('div');
        mask.className = 'mmh-card-mask';
        mask.innerHTML = `
          <div class="mmh-sync-pill">
            <span class="mmh-spinner"></span>
            <span class="mmh-sync-pill-text">同步中…</span>
          </div>
        `;
        hostEl.appendChild(mask);
      }
      return mask;
    }

    function lockCards(targets, text = '同步中…', delay = 150) {
      const elements = resolveElements(targets);
      if (elements.length === 0) return () => {};

      elements.forEach(hostEl => {
        let st = cardStateMap.get(hostEl);
        if (!st) {
          st = { count: 0, timer: null };
          cardStateMap.set(hostEl, st);
        }
        st.count++;

        const mask = ensureCardMask(hostEl);
        mask.querySelector('.mmh-sync-pill-text').textContent = text;

        if (st.count === 1) {
          clearTimeout(st.timer);
          if (delay <= 0) {
            mask.classList.add('open');
            hostEl.setAttribute('aria-busy', 'true');
          } else {
            st.timer = setTimeout(() => {
              if (st.count > 0) {
                mask.classList.add('open');
                hostEl.setAttribute('aria-busy', 'true');
              }
            }, delay);
          }
        }
      });

      let released = false;
      return () => {
        if (released) return;
        released = true;
        elements.forEach(hostEl => {
          const st = cardStateMap.get(hostEl);
          if (!st) return;
          st.count = Math.max(0, st.count - 1);
          if (st.count === 0) {
            clearTimeout(st.timer);
            const mask = hostEl.querySelector(':scope > .mmh-card-mask');
            if (mask) mask.classList.remove('open');
            hostEl.removeAttribute('aria-busy');
          }
        });
      };
    }

    function acquire(action, opts = {}) {
      const rule = ACTION_SYNC_RULES[action] || { mode: 'none' };
      const mode = opts.sync || rule.mode;
      const text = opts.syncText || rule.text || (mode === 'global' ? '資料處理中…' : '同步中…');

      if (mode === 'global') return lockGlobal(text);
      if (mode === 'card' && opts.targets) {
        const delay = typeof opts.delay === 'number' ? opts.delay : 150;
        return lockCards(opts.targets, text, delay);
      }
      return () => {};
    }

    return { acquire, lockGlobal, lockCards };
  })();

  // ==================== API 通訊層 ====================
  async function api(action, data = {}, opts = {}) {
    const token = localStorage.getItem(STORAGE.TOKEN) || '';
    const releaseSync = SyncUI.acquire(action, opts);

    try {
      const backend = await getBackend();
      const json = await backend.dispatchApi(action, token, data);
      if (!json.ok) {
        if ((json.code === 'UNAUTHORIZED' || json.code === 'ACCOUNT_DISABLED') && !opts.skipAuthRedirect) {
          clearSession();
          showLoginScreen(json.message);
        }
        const err = new Error(json.message || '操作失敗');
        err.code = json.code;
        throw err;
      }

      if (json._auth) {
        const prev = getUser();
        saveAuthState(json._auth);
        const next = getUser();
        scheduleOneSignalInit(next);
        updateNavBellUI();
        if (next && next.mustResetPassword) {
          const fp = document.getElementById('mmhForcePwdModal');
          if (fp) fp.classList.add('open');
        }
        const changed = !prev || !next ||
          prev.role !== next.role ||
          prev.status !== next.status ||
          prev.displayName !== next.displayName ||
          JSON.stringify(prev.deletionRequest || null) !== JSON.stringify(next.deletionRequest || null);
        if (changed && next) {
          window.dispatchEvent(new CustomEvent('mmh:authSynced', { detail: next }));
        }
      }

      return json;
    } finally {
      releaseSync();
    }
  }

  // ==================== 輕量 Markdown 解析器（供 [i] 使用說明書離線渲染） ====================
  function inlineMd(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s;
  }

  function renderMarkdownToHtml(mdText) {
    const lines = String(mdText || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) { i++; continue; }

      if (/^---+$/.test(trimmed)) {
        html += '<hr>';
        i++;
        continue;
      }

      const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        html += `<h${lvl}>${inlineMd(hMatch[2])}</h${lvl}>`;
        i++;
        continue;
      }

      if (trimmed.startsWith('>')) {
        const bqLines = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          bqLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        html += `<blockquote>${bqLines.map(inlineMd).join('<br>')}</blockquote>`;
        continue;
      }

      // Markdown 表格
      if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|\s*:?-+:?\s*\|/.test(lines[i + 1].trim())) {
        const parseCells = (rowStr) => rowStr.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const headers = parseCells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(parseCells(lines[i]));
          i++;
        }
        html += `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${inlineMd(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        continue;
      }

      // 編號清單
      if (/^\d+\.\s+/.test(trimmed)) {
        html += '<ol>';
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          html += `<li>${inlineMd(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`;
          i++;
        }
        html += '</ol>';
        continue;
      }

      // 項目符號清單（支援縮排子項目）
      if (/^[-*]\s+/.test(trimmed)) {
        html += '<ul>';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const itemTxt = lines[i].trim().replace(/^[-*]\s+/, '');
          html += `<li>${inlineMd(itemTxt)}</li>`;
          i++;
        }
        html += '</ul>';
        continue;
      }

      // 一般段落
      const pLines = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || /^(#{1,3}\s|---+$|>|\||[-*]\s|\d+\.\s)/.test(t)) break;
        pLines.push(t);
        i++;
      }
      html += `<p>${pLines.map(inlineMd).join('<br>')}</p>`;
    }

    return html;
  }

  async function preloadUserGuide() {
    if (cachedGuideMd) return cachedGuideMd;
    try {
      const res = await fetch('docs/USER_GUIDE.md', { cache: 'default' });
      if (res.ok) {
        cachedGuideMd = await res.text();
        try { localStorage.setItem(STORAGE.GUIDE_MD, cachedGuideMd); } catch {}
        return cachedGuideMd;
      }
    } catch {}
    try {
      cachedGuideMd = localStorage.getItem(STORAGE.GUIDE_MD) || '';
    } catch {}
    return cachedGuideMd;
  }

  async function openHelpModal() {
    const modal = document.getElementById('mmhHelpModal');
    const bodyEl = document.getElementById('mmhHelpBody');
    if (!modal || !bodyEl) return;

    modal.classList.add('open');
    let md = await preloadUserGuide();
    if (!md) {
      bodyEl.innerHTML = '<div class="empty-state">無法載入使用說明書，請稍後再試。</div>';
      return;
    }

    const user = getUser();
    const isAdmin = Boolean(user && user.role === 'Admin');
    if (!isAdmin) {
      md = md.replace(/<!--\s*ADMIN_ONLY_START\s*-->[\s\S]*?<!--\s*ADMIN_ONLY_END\s*-->/g, '');
    } else {
      md = md.replace(/<!--\s*ADMIN_ONLY_(?:START|END)\s*-->/g, '');
    }

    bodyEl.innerHTML = `<div class="md-guide">${renderMarkdownToHtml(md)}</div>`;
    bodyEl.scrollTop = 0;
  }

  // ==================== 三態推播鈴鐺開關（灰 / 綠 / 紅斜線） ====================
  function isInAppBrowser() {
    const ua = navigator.userAgent || '';
    return /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(ua);
  }

  function isIosDevice() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  function isIosSafariNotStandalone() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    return isIosDevice() && !isStandalone;
  }

  function getBellVisualState() {
    const user = getUser();
    const supported = 'Notification' in window && 'serviceWorker' in navigator;
    const perm = supported ? Notification.permission : 'default';

    const localSub = localStorage.getItem(STORAGE.PUSH_SUBSCRIBED) === '1';
    const userSub = Boolean(user && user.pushSubscribed);
    const isSubscribed = localSub || userSub || perm === 'granted' || perm === 'denied';

    const localEnabledRaw = localStorage.getItem(STORAGE.PUSH_ENABLED);
    const appEnabled = localEnabledRaw !== null
      ? (localEnabledRaw !== '0')
      : (user ? user.pushEnabled !== false : true);

    if (perm === 'granted' && !localSub) {
      try { localStorage.setItem(STORAGE.PUSH_SUBSCRIBED, '1'); } catch {}
    }

    if (!isSubscribed) {
      return { state: 'unsubscribed', perm, appEnabled, label: '尚未開啟手機推播（點擊訂閱）' };
    }
    if (perm === 'granted' && appEnabled) {
      return { state: 'enabled', perm, appEnabled, label: '手機推播開啟中（點擊暫停推播）' };
    }
    if (perm === 'denied') {
      return { state: 'muted', perm, appEnabled, blocked: true, label: '手機系統通知已關閉（點擊查看開啟方式）' };
    }
    return { state: 'muted', perm, appEnabled, blocked: false, label: '手機推播已暫停（點擊恢復開啟）' };
  }

  function getBellSvg(state) {
    if (state === 'muted') {
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          <path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path>
          <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path>
          <path d="M18 8a6 6 0 0 0-9.33-5"></path>
          <line x1="2" y1="2" x2="22" y2="22"></line>
        </svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
    `;
  }

  function updateNavBellUI() {
    const btn = document.getElementById('navPushBellBtn');
    if (!btn) return;
    const info = getBellVisualState();
    btn.classList.remove('state-unsubscribed', 'state-enabled', 'state-muted');
    btn.classList.add('state-' + info.state);
    btn.setAttribute('title', info.label);
    btn.setAttribute('aria-label', info.label);
    btn.innerHTML = getBellSvg(info.state);
  }

  function openPushGuideModal(mode = 'install') {
    const modal = document.getElementById('mmhPushGuideModal');
    const titleEl = document.getElementById('mmhPushGuideTitle');
    const bodyEl = document.getElementById('mmhPushGuideBody');
    if (!modal || !bodyEl) return;

    if (mode === 'inapp') {
      titleEl.textContent = '🌐 請改用系統瀏覽器開啟';
      bodyEl.innerHTML = `
        <div class="alert alert-warning">
          偵測到您目前正在 <strong>LINE / IG / FB 內建瀏覽器</strong> 中開啟，無法啟用手機推播。
        </div>
        <p style="font-size:0.9rem; line-height:1.65;">
          請點擊畫面右上角或右下角選單，選擇<strong>「以預設瀏覽器開啟（Safari / Chrome）」</strong>，加入主畫面後再點一次鈴鐺即可開啟推播。
        </p>
      `;
    } else if (mode === 'blocked') {
      titleEl.textContent = '🔕 手機系統已關閉通知權限';
      bodyEl.innerHTML = `
        <div class="alert alert-warning">
          您先前已在手機系統設定中關閉了 MayMayHome 的通知權限（<strong>不影響首頁貓咪「通知中心」收訊</strong>）。
        </div>
        <p style="font-size:0.9rem; font-weight:700; margin-bottom:6px;">重新開啟步驟：</p>
        <ol style="font-size:0.88rem; line-height:1.7; padding-left:20px; margin:0 0 10px;">
          <li><strong>iPhone：</strong>前往手機「設定 → 通知 → MayMayHome」開啟「允許通知」。</li>
          <li><strong>Android：</strong>前往「設定 → 應用程式 → Chrome / MayMayHome → 通知」開啟允許。</li>
          <li>完成後回到 MayMayHome，頂部鈴鐺會自動同步變回綠色。</li>
        </ol>
      `;
    } else {
      titleEl.textContent = '📲 加入主畫面即可開啟推播';
      const canInstallAndroid = Boolean(deferredInstallPrompt);
      bodyEl.innerHTML = `
        <div class="alert alert-info">
          ${isIosDevice()
            ? 'iPhone 系統規定必須先將網頁<strong>「加入主畫面」</strong>並從桌面圖示開啟，才能接收即時推播通知。'
            : '建議將 MayMayHome 加入手機桌面，像原生 App 一樣全螢幕秒開並接收通知。'}
        </div>
        <p style="font-size:0.9rem; font-weight:700; margin:10px 0 6px;">🍎 iPhone（Safari）：</p>
        <ol style="font-size:0.88rem; line-height:1.65; padding-left:20px; margin:0 0 12px;">
          <li>點擊 Safari 底部正中央的<strong>「分享」圖示</strong>（方框＋向上箭頭）。</li>
          <li>往下滑選擇<strong>「加入主畫面」</strong>，再點右上角<strong>「新增」</strong>。</li>
          <li>從手機桌面的貓咪圖示重新開啟 MayMayHome，再點右上角鈴鐺允許通知。</li>
        </ol>
        <p style="font-size:0.9rem; font-weight:700; margin:10px 0 6px;">🤖 Android（Chrome）：</p>
        <ol style="font-size:0.88rem; line-height:1.65; padding-left:20px; margin:0;">
          <li>點擊 Chrome 右上角<strong>「⋮」選單</strong>，選擇<strong>「新增至主畫面」</strong>或<strong>「安裝應用程式」</strong>。</li>
          <li>從桌面圖示開啟後點右上角鈴鐺即可。</li>
        </ol>
        ${canInstallAndroid ? `<button type="button" class="btn btn-primary btn-block" style="margin-top:14px;" id="mmhOneClickInstallBtn">⬇️ 一鍵安裝至主畫面</button>` : ''}
      `;
      if (canInstallAndroid) {
        setTimeout(() => {
          const btn = document.getElementById('mmhOneClickInstallBtn');
          if (btn) {
            btn.onclick = async () => {
              deferredInstallPrompt.prompt();
              await deferredInstallPrompt.userChoice;
              deferredInstallPrompt = null;
              modal.classList.remove('open');
            };
          }
        }, 0);
      }
    }

    modal.classList.add('open');
  }

  async function savePushPref(pushSubscribed, pushEnabled) {
    try {
      if (pushSubscribed !== undefined) localStorage.setItem(STORAGE.PUSH_SUBSCRIBED, pushSubscribed ? '1' : '0');
      if (pushEnabled !== undefined) localStorage.setItem(STORAGE.PUSH_ENABLED, pushEnabled ? '1' : '0');
    } catch {}
    if (currentUser) {
      if (pushSubscribed !== undefined) currentUser.pushSubscribed = pushSubscribed;
      if (pushEnabled !== undefined) currentUser.pushEnabled = pushEnabled;
      try { localStorage.setItem(STORAGE.USER, JSON.stringify(currentUser)); } catch {}
    }
    updateNavBellUI();

    try {
      await api('notification.setPushPref', { pushSubscribed, pushEnabled }, { sync: 'none', skipAuthRedirect: true });
    } catch (e) {
      console.warn('savePushPref skipped:', e.message);
    }
  }

  async function handleNavBellClick() {
    if (isInAppBrowser()) {
      openPushGuideModal('inapp');
      return;
    }
    if (isIosSafariNotStandalone()) {
      openPushGuideModal('install');
      return;
    }

    const appId = localStorage.getItem(STORAGE.PUSH_APP_ID);
    if (!appId) {
      toast('尚未在 Cloudflare 設定 ONESIGNAL_APP_ID', 'warning');
      return;
    }

    const info = getBellVisualState();

    // 1. 系統權限已被封鎖 -> 顯示系統設定指引
    if (info.blocked) {
      openPushGuideModal('blocked');
      return;
    }

    // 2. 目前為綠色開啟 -> 切換為暫停手機推播（不影響通知中心收訊）
    if (info.state === 'enabled') {
      try {
        if (window.OneSignal && window.OneSignal.User && window.OneSignal.User.PushSubscription) {
          await window.OneSignal.User.PushSubscription.optOut();
        }
      } catch {}
      await savePushPref(true, false);
      toast('🔕 已暫停手機推播（首頁通知中心仍會照常收訊）', 'info');
      return;
    }

    // 3. 灰色未訂閱 或 紅色暫停 -> 開啟／恢復手機推播
    if (!window.OneSignal) {
      initOneSignal(getUser());
      for (let i = 0; i < 15 && !window.OneSignal; i++) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (!window.OneSignal) {
      toast('推播模組載入中，請稍後再點一次', 'info');
      return;
    }

    try {
      if (Notification.permission !== 'granted') {
        await window.OneSignal.Notifications.requestPermission();
      }
      if (Notification.permission === 'granted') {
        const user = getUser();
        if (user && user.userId) {
          await window.OneSignal.login(user.userId);
        }
        if (window.OneSignal.User && window.OneSignal.User.PushSubscription) {
          try { await window.OneSignal.User.PushSubscription.optIn(); } catch {}
        }
        await savePushPref(true, true);
        toast('🔔 已開啟家庭即時推播通知！', 'success');
        window.dispatchEvent(new CustomEvent('mmh:pushReady'));
      } else if (Notification.permission === 'denied') {
        await savePushPref(true, false);
        openPushGuideModal('blocked');
      } else {
        toast('尚未允許通知權限', 'warning');
      }
    } catch (err) {
      toast('切換通知狀態失敗：' + err.message, 'error');
    }
  }

  function setupPermissionSyncWatchers() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') updateNavBellUI();
    });
    window.addEventListener('focus', updateNavBellUI);
    window.addEventListener('mmh:pushReady', updateNavBellUI);

    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      navigator.permissions.query({ name: 'notifications' }).then((status) => {
        status.onchange = () => updateNavBellUI();
      }).catch(() => {});
    }
  }

  // ==================== OneSignal Web Push v16 引擎 ====================
  function scheduleOneSignalInit(user) {
    if (oneSignalInitialized || oneSignalScheduled) return;
    const appId = localStorage.getItem(STORAGE.PUSH_APP_ID);
    if (!appId || location.protocol === 'file:') return;
    oneSignalScheduled = true;

    const trigger = () => initOneSignal(user || getUser());
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(trigger, { timeout: 1500 });
    } else {
      setTimeout(trigger, 1200);
    }
  }

  function initOneSignal(user) {
    const appId = localStorage.getItem(STORAGE.PUSH_APP_ID);
    if (!appId || oneSignalInitialized || location.protocol === 'file:') return;
    oneSignalInitialized = true;

    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        await OneSignal.init({
          appId: appId,
          allowLocalhostAsSecureOrigin: true,
          welcomeNotification: {
            title: '🐈 MayMayHome 通知已開啟',
            message: '未來瓦斯換桶、家庭公告與月底公費結算都會即時通知您！'
          }
        });
        if (user && user.userId) {
          await OneSignal.login(user.userId);
        }

        // 前景推播監聽：就算正開著 App 也能即時看到浮動橫幅並刷新通知中心
        if (OneSignal.Notifications && typeof OneSignal.Notifications.addEventListener === 'function') {
          OneSignal.Notifications.addEventListener('foregroundWillDisplay', (event) => {
            const n = event.notification || {};
            showForegroundPushBanner(n.title, n.body, n.launchURL);
            window.dispatchEvent(new CustomEvent('mmh:foregroundPush', { detail: n }));
          });
          OneSignal.Notifications.addEventListener('permissionChange', () => {
            updateNavBellUI();
          });
        }

        updateNavBellUI();
        window.dispatchEvent(new CustomEvent('mmh:pushReady'));
      } catch (err) {
        console.warn('OneSignal init skipped:', err);
      }
    });

    if (!document.getElementById('onesignal-sdk-script')) {
      const script = document.createElement('script');
      script.id = 'onesignal-sdk-script';
      script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      script.defer = true;
      document.head.appendChild(script);
    }
  }

  function getPushState() {
    const appId = localStorage.getItem(STORAGE.PUSH_APP_ID);
    const bell = getBellVisualState();
    return {
      configured: Boolean(appId),
      supported: 'Notification' in window && 'serviceWorker' in navigator,
      granted: bell.state === 'enabled',
      iosNeedInstall: isIosSafariNotStandalone(),
      bellState: bell.state
    };
  }

  async function requestPushPermission() {
    await handleNavBellClick();
    return getBellVisualState().state === 'enabled';
  }

  // ==================== App 冷啟動 3 秒貓咪讀取畫面＋背景預載 ====================
  async function runColdStartSplash(activePage, hasToken) {
    try {
      if (sessionStorage.getItem('mmh_splash_done') === '1') return false;
      sessionStorage.setItem('mmh_splash_done', '1');
    } catch {
      return false;
    }

    const splash = document.createElement('div');
    splash.id = 'mmhSplash';
    splash.className = 'mmh-splash open';
    splash.innerHTML = `
      <div class="mmh-splash-inner">
        <img src="assets/loading-cat.webp" alt="MayMayHome 載入中" class="mmh-splash-cat"
             onerror="this.style.display='none'">
        <div class="mmh-splash-brand">MayMayHome</div>
        <div class="mmh-splash-progress-wrap">
          <div class="mmh-splash-bar-track">
            <div class="mmh-splash-bar-fill" id="mmhSplashFill"></div>
          </div>
          <div class="mmh-splash-meta">
            <span id="mmhSplashStatus">正在啟動 MayMayHome…</span>
            <span class="mmh-splash-pct" id="mmhSplashPct">8%</span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(splash);

    const fillEl = splash.querySelector('#mmhSplashFill');
    const pctEl = splash.querySelector('#mmhSplashPct');
    const statusEl = splash.querySelector('#mmhSplashStatus');

    let curPct = 8;
    const setProgress = (pct, msg) => {
      if (pct > curPct) curPct = Math.min(100, pct);
      if (fillEl) fillEl.style.width = curPct + '%';
      if (pctEl) pctEl.textContent = Math.round(curPct) + '%';
      if (msg && statusEl) statusEl.textContent = msg;
    };

    const startTime = Date.now();
    const MIN_MS = 3000;
    const MAX_MS = 6500;

    // 溫和推進視覺進度，讓 3 秒內持續流暢前進
    const tickTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const target = Math.min(92, 10 + Math.floor((elapsed / MIN_MS) * 80));
      if (target > curPct) setProgress(target);
    }, 140);

    // 並行執行真實預載任務（絕不浪費這 3 秒）
    const preloadWork = (async () => {
      try {
        setProgress(18, '連線雲端資料庫…');
        await Promise.all([
          getBackend(),
          preloadUserGuide()
        ]);

        if (!hasToken) {
          setProgress(75, '準備登入畫面…');
          return;
        }

        setProgress(45, '驗證成員身分與通知中心…');
        const user = getUser();
        const tasks = [
          api('dashboard.getSummary', {}, { sync: 'none', skipAuthRedirect: true })
            .then(r => { if (r && r.data) setCache('dashboard', r.data); })
            .catch(() => {})
        ];

        // 預載公費與居家設備快取，進分頁即秒顯最新資料
        tasks.push(
          api('finance.getMonthData', { month: '' }, { sync: 'none', skipAuthRedirect: true })
            .then(r => {
              if (r && r.data) {
                setCache('finance_latest', r.data);
                if (r.data.month) setCache('finance_' + r.data.month, r.data);
              }
            })
            .catch(() => {})
        );

        if (!user || user.status === '啟用') {
          tasks.push(
            api('home.getSummary', {}, { sync: 'none', skipAuthRedirect: true })
              .then(r => {
                if (r && r.data) {
                  if (r.data.gas) setCache('gas', r.data.gas);
                  if (r.data.devices) setCache('homekit', r.data.devices);
                }
              })
              .catch(() => {})
          );
        }

        setProgress(68, '同步公費、瓦斯與通知快取…');
        await Promise.all(tasks);
        setProgress(95, '準備完成！');
      } catch (e) {
        console.warn('Splash preload skipped:', e);
      }
    })();

    // 等待：至少滿 3 秒 且 預載完成（最多不超過 6.5 秒斷網防呆）
    await Promise.race([
      Promise.all([
        preloadWork,
        new Promise(r => setTimeout(r, MIN_MS))
      ]),
      new Promise(r => setTimeout(r, MAX_MS))
    ]);

    clearInterval(tickTimer);
    setProgress(100, '準備完成！');
    await new Promise(r => setTimeout(r, 180));

    splash.classList.add('fade-out');
    splash.classList.remove('open');
    setTimeout(() => splash.remove(), 450);
    return true;
  }

  // ==================== 共用殼層（頂部導覽列＋底部 Liquid Glass＋彈窗） ====================
  function injectShell(activePage) {
    document.body.classList.add('page-' + activePage);
    const user = getUser();
    const navItems = [
      { id: 'index',    href: 'index.html',    icon: '🏠', label: '首頁' },
      { id: 'finance',  href: 'finance.html',  icon: '💰', label: '公費' },
      { id: 'home',     href: 'home.html',     icon: '🔥', label: '居家設備' },
      { id: 'settings', href: 'settings.html', icon: '⚙️', label: '設定' }
    ];
    const activeIdx = Math.max(0, navItems.findIndex(n => n.id === activePage));

    // 頂部導覽列（新增三態推播鈴鐺開關 + [i] 使用說明書按鈕）
    const topNav = document.createElement('header');
    topNav.className = 'top-nav';
    topNav.innerHTML = `
      <a href="index.html" class="brand">
        <img src="assets/maymay-icon.png" alt="MayMay" class="brand-avatar"
             onerror="this.outerHTML='<span class=\\'brand-avatar\\'>🐈</span>'">
        <span>MayMayHome</span>
      </a>
      <nav class="desktop-links">
        ${navItems.map(n => `<a href="${n.href}" class="${activePage === n.id ? 'active' : ''}">${n.icon} ${n.label}</a>`).join('')}
      </nav>
      <div class="nav-user">
        <button type="button" class="nav-icon-btn nav-bell-btn state-unsubscribed" id="navPushBellBtn" title="手機推播開關" aria-label="手機推播開關"></button>
        <button type="button" class="nav-icon-btn nav-info-btn" id="navHelpBtn" title="使用說明書" aria-label="使用說明書">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        </button>
        <span class="user-pill" id="navUserPill">${user ? escapeHtml(user.displayName) : '訪客'}</span>
      </div>
    `;
    document.body.prepend(topNav);

    // 手機底部 iOS Liquid Glass 懸浮導覽列
    const bottomNav = document.createElement('nav');
    bottomNav.className = 'bottom-nav';
    bottomNav.setAttribute('aria-label', '主要功能導覽');
    bottomNav.innerHTML = `
      <div class="bottom-nav-glass">
        <div class="bottom-nav-inner" style="--nav-index: ${activeIdx};">
          <div class="bottom-nav-pill" aria-hidden="true">
            <div class="bottom-nav-pill-inner"></div>
          </div>
          ${navItems.map((n, idx) => `
            <a href="${n.href}" data-nav-idx="${idx}" class="${idx === activeIdx ? 'active' : ''}">
              <span class="nav-ico">${n.icon}</span>
              <span>${n.label}</span>
            </a>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(bottomNav);
    initLiquidBottomNav(bottomNav, activeIdx);

    // 登入全螢幕遮罩
    const loginDiv = document.createElement('div');
    loginDiv.id = 'mmhLoginScreen';
    loginDiv.className = 'login-screen';
    loginDiv.innerHTML = `
      <div class="login-card">
        <div class="login-hero-wrap">
          <img src="assets/maymay-login.jpg" alt="MayMayHome"
               onerror="this.style.display='none'; this.parentElement.insertAdjacentHTML('beforeend', '<span>🐈</span>');">
        </div>
        <div class="login-card-body">
          <h2 class="login-title">歡迎回到 MayMayHome</h2>
          <p class="login-subtitle">請登入家庭成員帳號以查看通知與帳務</p>
          <div id="loginErrorAlert" class="alert alert-warning hidden"></div>
          <form id="mmhLoginForm">
            <div class="form-group">
              <label for="loginUsername">登入帳號</label>
              <input id="loginUsername" class="form-control" type="text" autocomplete="username" placeholder="請輸入帳號" required>
            </div>
            <div class="form-group">
              <label for="loginPassword">密碼</label>
              <input id="loginPassword" class="form-control" type="password" autocomplete="current-password" placeholder="請輸入密碼" required>
            </div>
            <button type="submit" id="loginSubmitBtn" class="btn btn-primary btn-block" style="padding: 12px;">登入系統</button>
          </form>
          <p class="form-hint" style="text-align:center; margin-top:14px;">
            忘記密碼？請聯繫管理員於後台一鍵重設臨時密碼。
          </p>
        </div>
      </div>
    `;
    document.body.appendChild(loginDiv);

    // 首次登入 / 重設後強制改密彈窗
    const forcePwdDiv = document.createElement('div');
    forcePwdDiv.id = 'mmhForcePwdModal';
    forcePwdDiv.className = 'modal-backdrop';
    forcePwdDiv.innerHTML = `
      <div class="modal-box" style="max-width:420px;">
        <div class="modal-header">
          <h3>🔐 請設定您的新密碼</h3>
        </div>
        <form id="mmhForcePwdForm">
          <div class="modal-body">
            <div class="alert alert-info">
              您目前使用初始或臨時密碼登入，請先設定一組專屬密碼（至少 4 碼）再繼續使用。
            </div>
            <div class="form-group">
              <label for="forceNewPwd">新密碼</label>
              <input id="forceNewPwd" class="form-control" type="password" minlength="4" required placeholder="至少 4 碼">
            </div>
            <div class="form-group">
              <label for="forceConfirmPwd">再次確認新密碼</label>
              <input id="forceConfirmPwd" class="form-control" type="password" minlength="4" required placeholder="請再輸入一次">
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" id="forcePwdBtn" class="btn btn-primary btn-block">儲存新密碼並進入</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(forcePwdDiv);

    // [i] 使用說明書彈窗
    const helpDiv = document.createElement('div');
    helpDiv.id = 'mmhHelpModal';
    helpDiv.className = 'modal-backdrop';
    helpDiv.innerHTML = `
      <div class="modal-box" style="max-width:640px;">
        <div class="modal-header">
          <h3>📖 MayMayHome 使用說明</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="mmhHelpCloseBtn">✕</button>
        </div>
        <div class="modal-body" id="mmhHelpBody">
          <div class="empty-state">載入使用說明書中…</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary btn-sm" id="mmhHelpOkBtn">我知道了</button>
        </div>
      </div>
    `;
    document.body.appendChild(helpDiv);

    // 推播／加入主畫面引導彈窗
    const pushGuideDiv = document.createElement('div');
    pushGuideDiv.id = 'mmhPushGuideModal';
    pushGuideDiv.className = 'modal-backdrop';
    pushGuideDiv.innerHTML = `
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3 id="mmhPushGuideTitle">📲 加入主畫面教學</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="mmhPushGuideCloseBtn">✕</button>
        </div>
        <div class="modal-body" id="mmhPushGuideBody"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary btn-sm" id="mmhPushGuideOkBtn">了解</button>
        </div>
      </div>
    `;
    document.body.appendChild(pushGuideDiv);

    bindShellEvents();
    updateNavBellUI();
    setupPermissionSyncWatchers();
  }

  function initLiquidBottomNav(bottomNav, activeIdx) {
    const inner = bottomNav.querySelector('.bottom-nav-inner');
    const pill = bottomNav.querySelector('.bottom-nav-pill');
    const links = Array.from(bottomNav.querySelectorAll('a[data-nav-idx]'));
    if (!inner || !pill) return;

    let isNavigating = false;

    function setNavState(idx, animate) {
      if (!animate) {
        pill.classList.add('no-transition');
        inner.style.setProperty('--nav-index', String(idx));
        void pill.offsetWidth;
        pill.classList.remove('no-transition');
      } else {
        pill.classList.remove('is-sliding');
        void pill.offsetWidth;
        pill.classList.add('is-sliding');
        inner.style.setProperty('--nav-index', String(idx));
      }
      links.forEach((a, i) => a.classList.toggle('active', i === idx));
    }

    try {
      const settled = sessionStorage.getItem('mmh_nav_settled');
      const prevRaw = sessionStorage.getItem('mmh_prev_nav_idx');
      sessionStorage.removeItem('mmh_nav_settled');
      sessionStorage.setItem('mmh_prev_nav_idx', String(activeIdx));

      const prevIdx = prevRaw !== null ? Number(prevRaw) : activeIdx;
      if (settled !== String(activeIdx) && !isNaN(prevIdx) && prevIdx !== activeIdx) {
        setNavState(prevIdx, false);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setNavState(activeIdx, true));
        });
      }
    } catch {}

    links.forEach(link => {
      link.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

        const targetIdx = Number(link.dataset.navIdx);
        const href = link.getAttribute('href');
        if (!href) return;

        e.preventDefault();

        if (targetIdx === activeIdx) {
          pill.classList.remove('is-sliding');
          void pill.offsetWidth;
          pill.classList.add('is-sliding');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }

        if (isNavigating) return;
        isNavigating = true;

        setNavState(targetIdx, true);
        try {
          sessionStorage.setItem('mmh_nav_settled', String(targetIdx));
          sessionStorage.setItem('mmh_prev_nav_idx', String(targetIdx));
        } catch {}

        setTimeout(() => {
          window.location.href = href;
        }, 210);
      });
    });

    window.addEventListener('pageshow', (ev) => {
      if (ev.persisted) {
        isNavigating = false;
        setNavState(activeIdx, false);
        try { sessionStorage.setItem('mmh_prev_nav_idx', String(activeIdx)); } catch {}
      }
    });
  }

  function bindShellEvents() {
    document.getElementById('navPushBellBtn').addEventListener('click', handleNavBellClick);
    document.getElementById('navHelpBtn').addEventListener('click', openHelpModal);

    const closeHelp = () => document.getElementById('mmhHelpModal').classList.remove('open');
    document.getElementById('mmhHelpCloseBtn').addEventListener('click', closeHelp);
    document.getElementById('mmhHelpOkBtn').addEventListener('click', closeHelp);
    document.getElementById('mmhHelpModal').addEventListener('click', (e) => {
      if (e.target.id === 'mmhHelpModal') closeHelp();
    });

    const closeGuide = () => document.getElementById('mmhPushGuideModal').classList.remove('open');
    document.getElementById('mmhPushGuideCloseBtn').addEventListener('click', closeGuide);
    document.getElementById('mmhPushGuideOkBtn').addEventListener('click', closeGuide);
    document.getElementById('mmhPushGuideModal').addEventListener('click', (e) => {
      if (e.target.id === 'mmhPushGuideModal') closeGuide();
    });

    document.getElementById('mmhLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('loginSubmitBtn');
      const errBox = document.getElementById('loginErrorAlert');
      const username = document.getElementById('loginUsername').value.trim();
      const password = document.getElementById('loginPassword').value.trim();

      errBox.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = '驗證中...';

      try {
        const res = await api('auth.login', { username, password }, { skipAuthRedirect: true });
        saveAuthState(res.data);
        document.getElementById('mmhLoginScreen').classList.remove('open');
        document.getElementById('loginPassword').value = '';
        toast('歡迎回來，' + res.data.user.displayName + '！', 'success');
        handlePostAuth();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = '登入系統';
      }
    });

    document.getElementById('mmhForcePwdForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p1 = document.getElementById('forceNewPwd').value.trim();
      const p2 = document.getElementById('forceConfirmPwd').value.trim();
      if (p1.length < 4) return toast('新密碼至少需 4 碼', 'error');
      if (p1 !== p2) return toast('兩次輸入的新密碼不一致', 'error');

      const btn = document.getElementById('forcePwdBtn');
      btn.disabled = true;
      btn.textContent = '更新中...';
      try {
        await api('auth.changePassword', { oldPassword: '', newPassword: p1 });
        currentUser.mustResetPassword = false;
        localStorage.setItem(STORAGE.USER, JSON.stringify(currentUser));
        document.getElementById('mmhForcePwdModal').classList.remove('open');
        toast('新密碼設定完成！', 'success');
        if (onReadyCallback) onReadyCallback(currentUser, false);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '儲存新密碼並進入';
      }
    });
  }

  function saveAuthState(data) {
    if (data.token) localStorage.setItem(STORAGE.TOKEN, data.token);
    if (data.user) {
      currentUser = data.user;
      localStorage.setItem(STORAGE.USER, JSON.stringify(data.user));
      const pill = document.getElementById('navUserPill');
      if (pill) pill.textContent = data.user.displayName;
      if (data.user.pushSubscribed !== undefined) {
        try { localStorage.setItem(STORAGE.PUSH_SUBSCRIBED, data.user.pushSubscribed ? '1' : '0'); } catch {}
      }
      if (data.user.pushEnabled !== undefined) {
        try { localStorage.setItem(STORAGE.PUSH_ENABLED, data.user.pushEnabled ? '1' : '0'); } catch {}
      }
    }
    if (data.pushAppId !== undefined) {
      localStorage.setItem(STORAGE.PUSH_APP_ID, data.pushAppId || '');
    }
    if (data.uiDefaults) {
      uiDefaults = data.uiDefaults;
      localStorage.setItem(STORAGE.UI_DEFAULTS, JSON.stringify(data.uiDefaults));
    }
    updateNavBellUI();
  }

  function showLoginScreen(reasonMsg) {
    const screen = document.getElementById('mmhLoginScreen');
    const errBox = document.getElementById('loginErrorAlert');
    if (reasonMsg) {
      errBox.textContent = reasonMsg;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
    }
    screen.classList.add('open');
  }

  function logout() {
    if (window.OneSignal && typeof window.OneSignal.logout === 'function') {
      try { window.OneSignal.logout(); } catch {}
    }
    clearSession();
    toast('已登出帳號', 'info');
    showLoginScreen();
  }

  // ==================== 啟動生命週期 ====================
  async function verifySessionSilently() {
    try {
      const prev = getUser();
      const res = await api('auth.verify', {});
      saveAuthState(res.data);
      const next = getUser();
      scheduleOneSignalInit(next);
      if (next && next.mustResetPassword) {
        document.getElementById('mmhForcePwdModal').classList.add('open');
      }
      const changed = !prev || !next ||
        prev.role !== next.role ||
        prev.status !== next.status ||
        prev.displayName !== next.displayName ||
        JSON.stringify(prev.deletionRequest || null) !== JSON.stringify(next.deletionRequest || null);
      if (changed && next) {
        window.dispatchEvent(new CustomEvent('mmh:authSynced', { detail: next }));
      }
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED' && err.code !== 'ACCOUNT_DISABLED') {
        console.warn('Silent verify skipped:', err.message);
      }
    }
  }

  function handlePostAuth() {
    const user = getUser();
    if (!user) return showLoginScreen();
    scheduleOneSignalInit(user);
    updateNavBellUI();
    if (user.mustResetPassword) {
      document.getElementById('mmhForcePwdModal').classList.add('open');
      return;
    }
    if (onReadyCallback) onReadyCallback(user, false);
  }

  async function boot(activePage, onReady) {
    onReadyCallback = onReady;
    getBackend();
    injectShell(activePage);

    const token = localStorage.getItem(STORAGE.TOKEN);
    const cachedUser = getUser();
    const hasSession = Boolean(token && cachedUser);

    // 冷啟動播放 3 秒貓咪進度條動畫（同步預載快取）；同次開啟切換頁面不重播
    const didSplash = await runColdStartSplash(activePage, hasSession);

    const latestToken = localStorage.getItem(STORAGE.TOKEN);
    const latestUser = getUser();

    if (!latestToken || !latestUser) {
      showLoginScreen();
      return;
    }

    scheduleOneSignalInit(latestUser);
    updateNavBellUI();

    if (latestUser.mustResetPassword) {
      document.getElementById('mmhForcePwdModal').classList.add('open');
      return;
    }

    // 1. 立即以最新快取秒開畫面（冷啟動剛預載完就是最新資料）
    if (onReadyCallback) onReadyCallback(latestUser, true);
    // 2. 非冷啟動切換頁面時，立即發起業務 API 同步；冷啟動若已預載首頁/公費/居家，仍發一次無遮罩靜默校準或正常同步
    if (onReadyCallback) {
      const hasFreshCache =
        (activePage === 'index' && Boolean(getCache('dashboard'))) ||
        (activePage === 'finance' && Boolean(getCache('finance_latest'))) ||
        (activePage === 'home' && Boolean(getCache('gas')));
      if (didSplash && hasFreshCache) {
        // 已於 3 秒啟動畫面完成最新同步，無需再閃一次遮罩
        return;
      }
      onReadyCallback(latestUser, false);
    }
  }

  return {
    boot,
    api,
    syncUI: SyncUI,
    verifySessionSilently,
    getUser,
    getUiDefaults,
    getCache,
    setCache,
    logout,
    toast,
    copyText,
    escapeHtml,
    formatMoney,
    formatMonth,
    getCurrentMonthStr,
    getTodayStr,
    getPushState,
    requestPushPermission,
    openHelpModal,
    updateNavBellUI
  };
})();
