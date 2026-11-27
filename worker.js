/**
 * MayMayHome Cloudflare Worker
 * 功能：
 * 1. GET  /api/health      - 健康檢查與推播環境變數狀態
 * 2. GET  /api/push-config - 回傳公開的 ONESIGNAL_APP_ID 供前端初始化 OneSignal SDK
 * 3. POST /api/push        - 安全轉發 OneSignal Web Push 推播（REST API Key 僅存於 Worker 環境變數）
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 健康檢查
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonRes({
        ok: true,
        service: 'MayMayHome Worker',
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

    // 3. 轉發 OneSignal 推播
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

      const payload = {
        app_id: appId,
        target_channel: 'push',
        include_aliases: {
          external_id: userIds
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

      if (body.data) {
        payload.data = body.data;
      }

      const authPrefix = apiKey.startsWith('os_v2_') ? 'Key ' : 'Basic ';

      try {
        const res = await fetch('https://api.onesignal.com/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': authPrefix + apiKey
          },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        return jsonRes({
          ok: res.ok,
          sent: res.ok,
          statusCode: res.status,
          response: text
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
