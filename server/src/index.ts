import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { TUNING, parseClientMsg } from '@arena/shared';
import { Lobby } from './rooms';
import { Accounts } from './accounts';
import { createStore } from './store';
import { BotLearner, MeasureWorker } from './botlearn';
import { DevTools } from './devtools';
import { AdminLog } from './adminlog';
import { AiTune } from './aitune';
import { Suggestions } from './suggestions';
import { AVATAR_MAX_BYTES, REPLAY_MAX_BYTES, validateGif } from './accounts';
import type { Store } from './store';

export interface ServerOptions {
  port: number;
  host?: string;
  /** Milliseconds per tick (default: ARENA_TICK_MS, else 50). */
  tickMs?: number;
  practicePrepMs?: number;
  queuePrepMs?: number;
  /** Directory with the built client. Defaults to ../../client/dist. */
  staticDir?: string;
  /** Account storage. Defaults to Upstash from the environment, else memory. */
  accountStore?: Store;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json',
};

/**
 * The address a connection really comes from. Behind Render's proxy the client's own address is the LAST entry of
 * X-Forwarded-For (the proxy appends what it saw); anything before it is whatever the client chose to send, so trusting
 * the first entry would let anyone dodge the per-address limits on sign-up, login and the owner code.
 */
export function clientIp(fwd: string | string[] | undefined, remote: string | undefined): string {
  const hops = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || remote || '';
}

/**
 * Max inbound messages per second per socket: a client sends one input per tick plus a few actions, so the limit is twice the tick rate
 * plus a margin (never below 120): 120 at 50 ms ticks, 185 at 16 ms.
 */
export const maxMsgsPerSec = (tickMs: number): number => Math.max(120, Math.ceil(2000 / tickMs) + 60);

/** Milliseconds per tick from ARENA_TICK_MS: a whole number from 8 to 50 (default and fallback 50, with a warning for anything else). */
export function parseTickMs(raw: string | undefined, fallback: number = TUNING.tickMs): { tickMs: number; warning?: string } {
  if (raw === undefined || raw.trim() === '') return { tickMs: fallback };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 8 && n <= 50) return { tickMs: n };
  return { tickMs: fallback, warning: `ARENA_TICK_MS=${raw} is not a whole number from 8 to 50, using ${fallback}` };
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(opts.staticDir ?? path.join(here, '../../client/dist'));
  const store = opts.accountStore ?? createStore();
  const accounts = new Accounts(store, process.env.ARENA_OWNER_CODE);
  const measurer = new MeasureWorker();
  const botLearner = new BotLearner(store, Math.random, measurer.measure);
  console.log(`accounts: ${accounts.storeKind}${accounts.storeKind === 'memory' ? ' (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep accounts across restarts)' : ''}`);
  // dev tuning: numbers saved in game apply over the data files for everyone, and are proposed as pull requests
  const devTools = new DevTools(store, process.env);
  const tickEnv = parseTickMs(process.env.ARENA_TICK_MS);
  if (tickEnv.warning) console.warn(tickEnv.warning);
  const tickMs = opts.tickMs ?? tickEnv.tickMs;
  const msgLimit = maxMsgsPerSec(tickMs);
  console.log(`tick: ${tickMs} ms (${Math.round((10000 / tickMs)) / 10} Hz)${tickMs === TUNING.tickMs ? '' : ' (ARENA_TICK_MS)'}`);
  const lobby = new Lobby({ tickMs, practicePrepMs: opts.practicePrepMs ?? 3000, queuePrepMs: opts.queuePrepMs ?? 5000 }, accounts, botLearner, new Suggestions(store, process.env.SUGGESTION_WEBHOOK_URL), devTools, new AdminLog(store), new AiTune(process.env));

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      decodeURIComponent(url.pathname); // a malformed escape (e.g. /avatar/%E0) must be a 400, not a crash
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ persistent: accounts.persistent, bots: botLearner.summary(), tick: lobby.tickReport() }));
      return;
    }
    // the owner's offline study of how people beat the bots (scripts/study-replays.ts --server URL --code CODE)
    if (url.pathname.startsWith('/api/botlearn/') && req.method === 'GET') {
      const want = Buffer.from(process.env.ARENA_OWNER_CODE ?? '');
      const got = Buffer.from(String(req.headers['x-owner-code'] ?? ''));
      if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return void res.writeHead(403, { 'content-type': 'text/plain' }).end('owner code required');
      const rest = url.pathname.slice('/api/botlearn/'.length);
      const job = rest === 'export'
        ? botLearner.archived().then((index) => ({ type: 'application/json', body: Buffer.from(JSON.stringify({ index, ledger: botLearner.results(), lessons: botLearner.outplayLessons(), styles: botLearner.humanStyles() })) }))
        : rest.startsWith('replay/')
          ? botLearner.archivedReplay(rest.slice('replay/'.length)).then((b) => (b ? { type: 'application/octet-stream', body: b } : null))
          : Promise.resolve(null);
      job
        .then((r) => (r ? res.writeHead(200, { 'content-type': r.type, 'cache-control': 'no-store' }).end(r.body) : res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')))
        .catch(() => res.writeHead(500).end());
      return;
    }
    // the owner uploads a replay file (saved from a match) and forces the bots to train on it
    if (url.pathname === '/api/botlearn/upload' && req.method === 'POST') {
      const token = /^Bearer (\S{10,80})$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const fail = (code: number, msg: string) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, text: msg }));
      if (!token) return void fail(401, 'Sign in first.');
      const max = REPLAY_MAX_BYTES * 8; // a plain JSON replay is several times its gzipped size
      const chunks: Buffer[] = [];
      let size = 0;
      let dead = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) {
          dead = true;
          fail(413, 'That file is too big for a replay.');
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', async () => {
        if (dead) return;
        try {
          const a = await accounts.accountForToken(token);
          if (!a || !((await accounts.isOwnerSession(token, a)) || a.grants?.includes('dev'))) return void fail(403, 'Only the owner or a dev can train the bots on a file.');
          const id = `up${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
          const r = await lobby.trainOnReplay(a.name, Buffer.concat(chunks), id);
          res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(r));
        } catch {
          fail(500, 'Could not train on that file.');
        }
      });
      return;
    }
    if (url.pathname.startsWith('/avatar/') && req.method === 'GET') {
      accounts
        .getAvatar(decodeURIComponent(url.pathname.slice('/avatar/'.length)))
        .then((b) => {
          if (!b) return void res.writeHead(404).end();
          res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }).end(b);
        })
        .catch(() => res.writeHead(500).end());
      return;
    }
    if (url.pathname.startsWith('/api/replay/') && req.method === 'GET') {
      accounts
        .getReplay(url.pathname.slice('/api/replay/'.length))
        .then((b) => {
          if (!b) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('replay not found (they are kept for 30 days)');
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }).end(b);
        })
        .catch(() => res.writeHead(500).end());
      return;
    }
    if (url.pathname === '/api/avatar' && (req.method === 'POST' || req.method === 'DELETE')) {
      const token = /^Bearer (\S{10,80})$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const fail = (code: number, msg: string) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: msg }));
      if (!token) return void fail(401, 'Sign in first.');
      const chunks: Buffer[] = [];
      let size = 0;
      let dead = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > AVATAR_MAX_BYTES + 1024) {
          dead = true;
          fail(413, 'GIF is too big.');
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', async () => {
        if (dead) return;
        try {
          const a = await accounts.accountForToken(token);
          if (!a) return void fail(401, 'Session expired. Sign in again.');
          const ownerOk = await accounts.isOwnerSession(token, a);
          if (!accounts.canGif(a, ownerOk)) return void fail(403, 'You do not have the GIF icon ability.');
          let fresh;
          if (req.method === 'DELETE') fresh = await accounts.clearAvatar(a);
          else {
            const body = Buffer.concat(chunks);
            const bad = validateGif(body);
            if (bad) return void fail(400, bad);
            fresh = await accounts.setAvatar(a, body);
          }
          lobby.syncAccount(fresh);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ avatar: fresh.avatar ?? null }));
        } catch {
          fail(500, 'Could not save the icon.');
        }
      });
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.join(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found (has the client been built? npm run build)');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' }).end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32768 });
  const alive = new WeakSet<object>();

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
    const player = lobby.connect(ws, ip, String(req.headers['cf-ipcountry'] ?? ''));
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    let windowStart = Date.now();
    let count = 0;
    ws.on('message', (data: RawData) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > msgLimit) {
        ws.close(1008, 'rate limit');
        return;
      }
      const msg = parseClientMsg(data.toString());
      if (msg) lobby.handle(player, msg);
    });
    ws.on('close', () => lobby.disconnect(player));
    ws.on('error', () => lobby.disconnect(player));
  });

  // Fixed-step loop: a 1 ms timer feeds a performance.now() accumulator, so ticks start within about a millisecond of
  // their time (a 10 ms timer quantised them). A late callback plays up to MAX_CATCHUP ticks back to back, the rest is dropped.
  const loop = startTickLoop(() => lobby.tick(), tickMs);

  // Drop dead connections (also keeps idle sockets open on hosts with proxy timeouts).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30000);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            loop.stop();
            clearInterval(heartbeat);
            void measurer.close();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

/** Calls `tick` every `stepMs` of real time using a 1 ms timer and a monotonic accumulator; at most `maxCatchup` ticks per callback (default 150 ms worth, at least 3). */
export function startTickLoop(tick: () => void, stepMs: number, maxCatchup = Math.max(3, Math.ceil(150 / stepMs)), now: () => number = () => performance.now()): { stop: () => void; step: () => number } {
  let last = now();
  let acc = 0;
  const step = () => {
    const t = now();
    acc += t - last;
    last = t;
    let n = 0;
    while (acc >= stepMs && n < maxCatchup) {
      acc -= stepMs;
      n++;
      tick();
    }
    if (acc >= stepMs) acc = 0; // fell badly behind: drop the backlog rather than spiral
    return n;
  };
  const timer = setInterval(step, 1);
  return { stop: () => clearInterval(timer), step };
}
