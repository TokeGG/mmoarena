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
import { AVATAR_MAX_BYTES, validateGif } from './accounts';
import type { Store } from './store';

export interface ServerOptions {
  port: number;
  host?: string;
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
  '.map': 'application/json',
};

/** Max inbound messages per second per socket. The client sends ~20 inputs/s plus a few actions. */
const MAX_MSGS_PER_SEC = 120;

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(opts.staticDir ?? path.join(here, '../../client/dist'));
  const accounts = new Accounts(opts.accountStore ?? createStore(), process.env.ARENA_OWNER_CODE);
  console.log(`accounts: ${accounts.storeKind}${accounts.storeKind === 'memory' ? ' (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep accounts across restarts)' : ''}`);
  const lobby = new Lobby({ practicePrepMs: opts.practicePrepMs ?? 3000, queuePrepMs: opts.queuePrepMs ?? 15000 }, accounts);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ persistent: accounts.persistent }));
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
    const fwd = req.headers['x-forwarded-for'];
    const ip = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || '';
    const player = lobby.connect(ws, ip);
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
      if (++count > MAX_MSGS_PER_SEC) {
        ws.close(1008, 'rate limit');
        return;
      }
      const msg = parseClientMsg(data.toString());
      if (msg) lobby.handle(player, msg);
    });
    ws.on('close', () => lobby.disconnect(player));
    ws.on('error', () => lobby.disconnect(player));
  });

  // Fixed-rate loop with an accumulator so a late timer fires extra ticks instead of slowing the game.
  const TICK = TUNING.tickMs;
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += now - last;
    last = now;
    let n = 0;
    while (acc >= TICK && n < 5) {
      acc -= TICK;
      n++;
      lobby.tick();
    }
    if (n === 5) acc = 0; // fell badly behind: drop the backlog rather than spiral
  }, 10);

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
            clearInterval(loop);
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
