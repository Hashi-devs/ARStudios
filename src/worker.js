// AR Studio on Cloudflare Workers. Pages and images in /public are served directly by
// Cloudflare; anything under /api comes here.
import { routes } from './api.js';
import { supabase } from './lib/supabase.js';
import { paystack } from './lib/paystack.js';
import { orders } from './lib/orders.js';
import { fail } from './lib/http.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // The two public lists (/api/site and /api/thanks) are kept at Cloudflare's edge for 30 seconds, so a rush of visitors
    // reads them once instead of asking the database every time. Admin and checkout calls are never cached.
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheable = cache && !request.headers.get('x-edge-cache') && request.method === 'GET' && (url.pathname === '/api/site' || url.pathname === '/api/thanks') && !url.search;
    if (cacheable) {
      const key = new Request(url.origin + url.pathname);
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await this.fetch(new Request(request.url, { method: 'GET', headers: { 'x-edge-cache': '1' } }), env, ctx);
      if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    const route = routes[url.pathname.replace(/\/+$/, '')];
    if (!route) return fail(404, 'Not found');
    const handler = route[request.method];
    if (!handler) {
      const r = fail(405, 'Method not allowed');
      r.headers.set('Allow', Object.keys(route).join(', '));
      return r;
    }
    try {
      // Built per request from your settings, so a missing setting gives a clear message.
      const light = url.pathname === '/api/config' || url.pathname === '/api/health';
      const sb = light ? null : supabase(env);
      const ps = paystack(env);
      return await handler({ request, env, ctx, url, sb, ps, ord: sb && orders(sb, ps) });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e && e.stack || e);
      return fail(status, status === 500 ? 'Something went wrong' : e.message);
    }
  },

  // Runs on a timer (see "triggers" in wrangler.jsonc). Supabase's free plan pauses a project after
  // a week with no activity, so this asks the database one small question every two days.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(supabase(env).db.select('settings', 'id=eq.1&select=goal')
      .then(() => console.log('Supabase kept awake'))
      .catch(e => console.error('Keep-awake failed', e && e.message)));
  },
};
