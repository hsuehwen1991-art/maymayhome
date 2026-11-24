/**
 * MayMayHome 前端共用核心引擎
 * 負責：GAS API 請求、登入與強制改密彈窗、共用導覽列注入、快取、OneSignal PWA 推播
 */

const App = (() => {
  // 已綁定你階段一部署成功的 GAS Web App 網址
  const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbxAzHiiXa0BKcQa-13GNlDY35aQqJAQ2wK1yTGT9LTjyhWI6gDY1cPgmB3O9fwEh8_d/exec';

  const STORAGE = {
    TOKEN: 'mmh_token',
    USER: 'mmh_user',
    PUSH_APP_ID: 'mmh_push_app_id',
    UI_DEFAULTS: 'mmh_ui_defaults'
  };

  let currentUser = null;
  let uiDefaults = { notifyOnExpense: false, notifyOnAnnouncement: true };
  let oneSignalInitialized = false;
  let onReadyCallback = null;

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

  // ==================== API 通訊層 ====================
  async function api(action, data = {}, opts = {}) {
    const token = localStorage.getItem(STORAGE.TOKEN) || '';
    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token, data })
    });

    if (!res.ok) {
      throw new Error('網路連線異常（HTTP ' + res.status + '）');
    }

    const json = await res.json();
    if (!json.ok) {
      if ((json.code === 'UNAUTHORIZED' || json.code === 'ACCOUNT_DISABLED') && !opts.skipAuthRedirect) {
        clearSession();
        showLoginScreen(json.message);
      }
      const err = new Error(json.message || '操作失敗');
      err.code = json.code;
      throw err;
    }
    return json;
  }

  // ==================== 共用殼層（導覽列 + 登入畫面 + 強制改密彈窗） ====================
  function injectShell(activePage) {
    const user = getUser();
    const navItems = [
      { id: 'index',    href: 'index.html',    icon: '🏠', label: '首頁' },
      { id: 'finance',  href: 'finance.html',  icon: '💰', label: '公費' },
      { id: 'home',     href: 'home.html',     icon: '🔥', label: '居家設備' },
      { id: 'settings', href: 'settings.html', icon: '⚙️', label: '設定' }
    ];

    // 頂部導覽列
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
        <span class="user-pill" id="navUserPill">${user ? escapeHtml(user.displayName) : '訪客'}</span>
      </div>
    `;
    document.body.prepend(topNav);

    // 手機底部導覽列
    const bottomNav = document.createElement('nav');
    bottomNav.className = 'bottom-nav';
    bottomNav.innerHTML = `
      <div class="bottom-nav-inner">
        ${navItems.map(n => `
          <a href="${n.href}" class="${activePage === n.id ? 'active' : ''}">
            <span class="nav-ico">${n.icon}</span>
            <span>${n.label}</span>
          </a>
        `).join('')}
      </div>
    `;
    document.body.appendChild(bottomNav);

    // 登入全螢幕遮罩（方案 B：16:9 貓咪主視覺）
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
          <p class="login-subtitle">請登入家庭成員帳號以查看公告與帳務</p>
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

    bindShellEvents();
  }

  function bindShellEvents() {
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
    }
    if (data.pushAppId !== undefined) {
      localStorage.setItem(STORAGE.PUSH_APP_ID, data.pushAppId || '');
    }
    if (data.uiDefaults) {
      uiDefaults = data.uiDefaults;
      localStorage.setItem(STORAGE.UI_DEFAULTS, JSON.stringify(data.uiDefaults));
    }
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

  // ==================== OneSignal Web Push v16 引擎 ====================
  function isIosSafariNotStandalone() {
    const ua = navigator.userAgent || '';
    const isIos = /iPhone|iPad|iPod/i.test(ua);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    return isIos && !isStandalone;
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
          allowLocalhostAsSecureOrigin: true
        });
        if (user && user.userId) {
          await OneSignal.login(user.userId);
        }
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
    if (!appId) return { configured: false, supported: false, granted: false, iosNeedInstall: false };
    if (isIosSafariNotStandalone()) {
      return { configured: true, supported: false, granted: false, iosNeedInstall: true };
    }
    const supported = 'Notification' in window && 'serviceWorker' in navigator;
    const granted = supported && Notification.permission === 'granted';
    return { configured: true, supported, granted, iosNeedInstall: false };
  }

  async function requestPushPermission() {
    const state = getPushState();
    if (!state.configured) {
      toast('尚未在後端設定 OneSignal App ID', 'warning');
      return false;
    }
    if (state.iosNeedInstall) {
      toast('iPhone 請先點擊 Safari 底部「分享 → 加入主畫面」，再從桌面開啟即可允許通知', 'warning');
      return false;
    }
    if (!window.OneSignal) {
      toast('推播模組載入中，請 2 秒後再點一次', 'info');
      return false;
    }
    try {
      await window.OneSignal.Notifications.requestPermission();
      const user = getUser();
      if (user && user.userId) {
        await window.OneSignal.login(user.userId);
      }
      if (Notification.permission === 'granted') {
        toast('🔔 已成功開啟家庭即時推播通知！', 'success');
        window.dispatchEvent(new CustomEvent('mmh:pushReady'));
        return true;
      } else {
        toast('您未允許通知權限，可在瀏覽器設定中重新開啟', 'warning');
        return false;
      }
    } catch (err) {
      toast('開啟通知失敗：' + err.message, 'error');
      return false;
    }
  }

  // ==================== 啟動生命週期 ====================
  function handlePostAuth() {
    const user = getUser();
    if (!user) return showLoginScreen();
    initOneSignal(user);
    if (user.mustResetPassword) {
      document.getElementById('mmhForcePwdModal').classList.add('open');
      return;
    }
    if (onReadyCallback) onReadyCallback(user, false);
  }

  async function boot(activePage, onReady) {
    onReadyCallback = onReady;
    injectShell(activePage);

    const token = localStorage.getItem(STORAGE.TOKEN);
    const cachedUser = getUser();

    if (!token || !cachedUser) {
      showLoginScreen();
      return;
    }

    // 先用快取使用者資訊秒開畫面（若有快取）
    if (!cachedUser.mustResetPassword && onReadyCallback) {
      onReadyCallback(cachedUser, true);
    }

    // 背景執行滑動續期驗證並同步最新權限/狀態
    try {
      const res = await api('auth.verify', {});
      saveAuthState(res.data);
      handlePostAuth();
    } catch (err) {
      // UNAUTHORIZED / ACCOUNT_DISABLED 已於 api() 自動處理導向登入
      if (err.code !== 'UNAUTHORIZED' && err.code !== 'ACCOUNT_DISABLED') {
        toast('離線或連線緩慢，目前顯示快取畫面', 'warning');
      }
    }
  }

  return {
    boot,
    api,
    getUser,
    getUiDefaults,
    getCache,
    setCache,
    logout,
    toast,
    copyText,
    escapeHtml,
    formatMoney,
    getCurrentMonthStr,
    getTodayStr,
    getPushState,
    requestPushPermission
  };
})();
