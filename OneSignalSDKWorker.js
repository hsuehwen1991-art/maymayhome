/**
 * MayMayHome Service Worker（OneSignal Web Push v16 ＋ 桌面圖示未讀數字角標）
 * - 監聽背景推播封包中的 unreadCount，自動呼叫 Web Badging API (setAppBadge / clearAppBadge)
 * - 不手動呼叫 showNotification()，完全交由 OneSignal 官方腳本顯示通知，避免重複兩則
 * - 支援主頁面透過 postMessage({ type: 'MMH_SYNC_BADGE', count }) 即時同步／歸零角標
 */

const MMH_BADGE_CACHE = 'mmh-badge-state-v1';
const MMH_BADGE_KEY = '/__mmh_badge_count__';

async function mmhReadStoredBadge() {
  try {
    const cache = await caches.open(MMH_BADGE_CACHE);
    const res = await cache.match(MMH_BADGE_KEY);
    if (!res) return 0;
    const n = Number(await res.text());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

async function mmhSaveStoredBadge(count) {
  try {
    const cache = await caches.open(MMH_BADGE_CACHE);
    await cache.put(MMH_BADGE_KEY, new Response(String(count)));
  } catch {}
}

async function mmhApplyAppBadge(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  await mmhSaveStoredBadge(n);
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    try {
      if (n > 0) {
        await self.navigator.setAppBadge(n);
      } else if (typeof self.navigator.clearAppBadge === 'function') {
        await self.navigator.clearAppBadge();
      } else {
        await self.navigator.setAppBadge(0);
      }
    } catch {}
  }
}

// 註冊於 OneSignal importScripts 之前，確保背景收到推播時必會更新桌面圖示數字
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let parsed = null;
    try {
      if (event.data) parsed = event.data.json();
    } catch {}

    // 依序檢查 OneSignal Web Push 附加資料欄位（custom.a / data / 根層）
    const candidates = [
      parsed && parsed.custom && parsed.custom.a && parsed.custom.a.unreadCount,
      parsed && parsed.data && parsed.data.unreadCount,
      parsed && parsed.unreadCount
    ];

    let nextCount = null;
    for (const v of candidates) {
      if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) {
        nextCount = Math.max(0, Math.floor(Number(v)));
        break;
      }
    }

    // 若非系統帶數推播（如後台測試推播），則於本機計數 +1
    if (nextCount === null) {
      const prev = await mmhReadStoredBadge();
      nextCount = prev + 1;
    }

    await mmhApplyAppBadge(nextCount);
  })());
});

// 接收前景頁面同步最新未讀數（已讀、全部已讀、登出時立即對齊或清零）
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'MMH_SYNC_BADGE') {
    event.waitUntil(mmhApplyAppBadge(msg.count));
  }
});

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
