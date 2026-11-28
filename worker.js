/**
 * MayMayHome Cloudflare Worker v2.1
 * 功能：
 * 1. GET  /api/health      - 健康檢查與推播環境變數狀態
 * 2. GET  /api/push-config - 回傳公開的 ONESIGNAL_APP_ID 供前端初始化 OneSignal SDK
 * 3. POST /api/push        - 安全轉發 OneSignal Web Push 推播（支援 per-user badgeMap 夾帶精準未讀數字）
 * 4. 其餘路徑              - 交由 Cloudflare Static Assets 回傳 HTML / JS / CSS / 圖片
 */

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function sendOneSignalRequest(appId, apiKey, payload) {
  const authPrefix = apiKey.startsWith('os_v2_') ? 'Key ' : 'Basic ';
  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': authPrefix + apiKey
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return {
    ok: res.ok,
    statusCode: res.status,
    response: text
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 健康檢查
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonRes({
        ok: true,
        service: 'MayMayHome Worker',
        version: '2.1',
        pushConfigured: Boolean(env.ONESIGNAL_APP_ID && env.ONESIGNAL_REST_API_KEY)
      });
    }

    // 2. 取得公開的 OneSignal App ID
    if (url.pathname === '/api/push-config' && request.method === 'GET') {
      return jsonRes({
        ok: true,
        appId: env.ONESIGNAL_APP_ID || ''
      });
    }

    // 3. 轉發 OneSignal 推播（支援依 badgeMap 分組，讓每位成員收到自己精準的桌面角標數字）
    if (url.pathname === '/api/push' && request.method === 'POST') {
      const appId = (env.ONESIGNAL_APP_ID || '').trim();
      const apiKey = (env.ONESIGNAL_REST_API_KEY || '').trim();

      if (!appId || !apiKey) {
        return jsonRes({ ok: false, sent: false, reason: 'NOT_CONFIGURED' }, 200);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonRes({ ok: false, sent: false, reason: 'INVALID_JSON' }, 400);
      }

      const title = String(body.title || '').trim();
      const message = String(body.message || '').trim();
      const userIds = Array.isArray(body.userIds) ? body.userIds.filter(Boolean) : [];

      if (!title || !message || userIds.length === 0) {
        return jsonRes({ ok: false, sent: false, reason: 'MISSING_FIELDS' }, 400);
      }

      const baseUrl = String(body.appUrl || url.origin).replace(/\/$/, '');
      const targetUrl = body.path ? (baseUrl + body.path) : baseUrl;
      const baseData = (body.data && typeof body.data === 'object') ? body.data : {};
      const badgeMap = (body.badgeMap && typeof body.badgeMap === 'object') ? body.badgeMap : null;

      // 依每位收件人的未讀數字分組：相同未讀數合併單次發送，不同未讀數並行發送
      const groups = new Map();
      if (badgeMap) {
        userIds.forEach((uid) => {
          const rawVal = badgeMap[uid];
          const badgeKey = (rawVal !== undefined && rawVal !== null && !isNaN(Number(rawVal)))
            ? String(Math.max(0, Math.floor(Number(rawVal))))
            : 'NONE';
          if (!groups.has(badgeKey)) groups.set(badgeKey, []);
          groups.get(badgeKey).push(uid);
        });
      } else {
        groups.set('NONE', userIds);
      }

      try {
        const tasks = Array.from(groups.entries()).map(([badgeKey, groupIds]) => {
          const mergedData = { ...baseData };
          if (badgeKey !== 'NONE') {
            mergedData.unreadCount = Number(badgeKey);
          }

          const payload = {
            app_id: appId,
            target_channel: 'push',
            include_aliases: {
              external_id: groupIds
            },
            headings: {
              en: title,
              'zh-Hant': title
            },
            contents: {
              en: message,
              'zh-Hant': message
            },
            url: targetUrl
          };

          if (Object.keys(mergedData).length > 0) {
            payload.data = mergedData;
          }

          return sendOneSignalRequest(appId, apiKey, payload);
        });

        const results = await Promise.all(tasks);
        const anyOk = results.some(r => r.ok);
        const first = results[0] || { statusCode: 200, response: '' };
        return jsonRes({
          ok: anyOk,
          sent: anyOk,
          statusCode: first.statusCode,
          groupsSent: results.length,
          response: first.response
        }, 200);
      } catch (err) {
        return jsonRes({ ok: false, sent: false, reason: err.message }, 502);
      }
    }

    // 4. 靜態資源服務
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
