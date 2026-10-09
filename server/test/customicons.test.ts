import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ICON_LIST, ICON_PACKS, iconExists, setCustomIcons, validPatch } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { AdminLog } from '../src/adminlog';
import { CUSTOM_LIMITS, CustomIcons, cleanIconName, iconSlug, webpSize } from '../src/customicons';
import { startServer } from '../src/index';

const real = fs.readFileSync(new URL('../../client/public/icons/barbarian/barbarian-1.webp', import.meta.url));
const b64 = real.toString('base64');
/** A lossless-looking WebP header of the given size (all the server reads), padded to `bytes`. */
const fake = (w: number, h: number, bytes = 60): Buffer => {
  const b = Buffer.alloc(bytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(bytes - 8, 4);
  b.write('WEBPVP8L', 8, 'latin1');
  b.writeUInt32LE(bytes - 20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
};
const pics = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Pic ${i + 1}`, webp: b64 }));

describe('custom icon packs', () => {
  afterEach(() => setCustomIcons([], []));

  it('reads WebP sizes and refuses anything else', () => {
    assert.deepEqual(webpSize(real), { w: 128, h: 128 });
    assert.deepEqual(webpSize(fake(128, 128)), { w: 128, h: 128 });
    assert.equal(webpSize(Buffer.from('GIF89a'.repeat(20))), null);
    const bad = Buffer.from(real);
    bad.write('RIFX', 0, 'latin1');
    assert.equal(webpSize(bad), null);
    assert.equal(webpSize(real.subarray(0, real.length - 2)), null, 'the RIFF length has to match');
    assert.equal(cleanIconName('  <b>Fire</b>  ball '), 'bFireb ball');
    assert.equal(iconSlug('Fire ball!!'), 'fire-ball');
  });

  it('stores a pack, lists it, serves it, and puts it in the library', async () => {
    const store = new MemoryStore();
    const c = new CustomIcons(store, new AdminLog(store));
    const r = await c.upload('Toke', { pack: 'my-pack', icons: [{ name: 'Fire ball', webp: b64 }, { name: 'Fire ball', webp: b64 }, { name: '', webp: b64 }] });
    assert.deepEqual(r, { ok: true, pack: 'my-pack', count: 3 });
    const l = c.list();
    assert.deepEqual(l.packs.map((p) => [p.id, p.count]), [['my-pack', 3]]);
    assert.deepEqual(l.icons.map((i) => i.id), ['my-pack/fire-ball', 'my-pack/fire-ball-2', 'my-pack/icon-3']);
    assert.equal(l.icons[0].file, '/icons/my-pack/fire-ball.webp');
    assert.deepEqual(await c.file('my-pack', 'fire-ball'), real);
    assert.equal(await c.file('my-pack', 'nope'), null);
    assert.equal(await c.file('../x', 'fire-ball'), null);
    assert.ok(ICON_PACKS.find((p) => p.id === 'my-pack')?.custom);
    assert.ok(iconExists('my-pack/fire-ball'));
    assert.ok(ICON_LIST.some((i) => i.id === 'my-pack/icon-3'));
    const log = await new AdminLog(store).list();
    assert.equal(log[0].action, 'uploaded an icon pack');
    assert.equal(log[0].by, 'Toke');
  });

  it('validates names and every picture', async () => {
    const c = new CustomIcons(new MemoryStore());
    const code = async (body: unknown) => {
      const r = await c.upload('Toke', body);
      return r.ok ? 200 : r.status;
    };
    for (const pack of ['a', 'Bad Name', 'UPPER', 'x'.repeat(25), '-lead', 'trail-', 'a_b', 'barbarian', 'steadykeel-framed', undefined, 7]) assert.equal(await code({ pack, icons: pics(1) }), 400, String(pack));
    assert.equal(await code({ pack: 'ok-name', icons: [] }), 400);
    assert.equal(await code({ pack: 'ok-name' }), 400);
    assert.equal(await code({ pack: 'ok-name', icons: [{ name: 'x', webp: Buffer.from('not a webp at all, just text').toString('base64') }] }), 400);
    assert.equal(await code({ pack: 'ok-name', icons: [{ name: 'x', webp: fake(64, 64).toString('base64') }] }), 400, 'must be 128 x 128');
    assert.equal(await code({ pack: 'ok-name', icons: [{ name: 'x', webp: fake(128, 128, CUSTOM_LIMITS.iconBytes + 2).toString('base64') }] }), 400, 'over 24 KB');
    assert.equal(await code({ pack: 'ok-name', icons: [{ name: 'x', webp: '!!!' }] }), 400);
    assert.equal(await code({ pack: 'ok-name', icons: [{ name: 'x' }] }), 400);
    assert.deepEqual(c.list().packs, [], 'nothing was kept');
    assert.equal(await code({ pack: 'ok-name', icons: pics(1) }), 200);
    assert.equal(await code({ pack: 'ok-name', icons: pics(1) }), 409, 'unique');
  });

  it('keeps to the limits: 400 pictures and 4 MB per upload, 20 packs, 2000 icons', async () => {
    const c = new CustomIcons(new MemoryStore());
    const big = fake(128, 128, 20 * 1024).toString('base64');
    const status = async (pack: string, icons: unknown[]) => {
      const r = await c.upload('Toke', { pack, icons });
      return r.ok ? 200 : r.status;
    };
    assert.equal(await status('too-many', pics(CUSTOM_LIMITS.perUpload + 1)), 400);
    // 210 x 20 KB is over 4 MB
    assert.equal(await status('too-big', Array.from({ length: 210 }, (_, i) => ({ name: `n${i}`, webp: big }))), 413);
    for (let i = 0; i < CUSTOM_LIMITS.packs; i++) assert.equal(await status(`pack-${i}`, pics(1)), 200);
    assert.equal(await status('one-more', pics(1)), 400, 'at most 20 packs');
    const d = new CustomIcons(new MemoryStore());
    for (let i = 0; i < 4; i++) assert.equal((await d.upload('Toke', { pack: `p-${i}`, icons: pics(400) })).ok, true);
    assert.equal((await d.upload('Toke', { pack: 'p-4', icons: pics(399) })).ok, true);
    assert.equal((await d.upload('Toke', { pack: 'p-5', icons: pics(1) })).ok, true, 'the 2000th');
    assert.equal((await d.upload('Toke', { pack: 'p-6', icons: pics(1) })).ok, false, 'over 2000 icons');
  });

  it('deletes a pack with its pictures and survives a restart', async () => {
    const store = new MemoryStore();
    const c = new CustomIcons(store, new AdminLog(store));
    await c.upload('Toke', { pack: 'keep-me', icons: pics(2) });
    await c.upload('Toke', { pack: 'drop-me', icons: pics(2) });
    setCustomIcons([], []);
    const again = new CustomIcons(store, new AdminLog(store));
    await again.ready;
    assert.deepEqual(again.list().packs.map((p) => p.id), ['keep-me', 'drop-me']);
    assert.ok(iconExists('keep-me/pic-1'), 'the library has it again after the restart');
    assert.deepEqual(await again.file('drop-me', 'pic-2'), real);
    assert.deepEqual(await again.remove('Toke', 'drop-me'), { ok: true, pack: 'drop-me', count: 2 });
    assert.equal(await store.get('icon:drop-me/pic-1'), null);
    assert.equal(await again.file('drop-me', 'pic-1'), null);
    assert.ok(!iconExists('drop-me/pic-1'));
    assert.equal((await again.remove('Toke', 'drop-me')).ok, false);
    const third = new CustomIcons(store);
    await third.ready;
    assert.deepEqual(third.list().packs.map((p) => p.id), ['keep-me']);
    assert.equal((await new AdminLog(store).list()).some((r) => r.action === 'deleted an icon pack' && r.target === 'drop-me'), true);
  });

  it('validPatch takes a custom icon id only while the server has it', async () => {
    const patch = { file: 'icons', id: 'fireball', path: ['ability'], value: 'my-pack/pic-1' } as const;
    assert.equal(validPatch(patch as any), false);
    const c = new CustomIcons(new MemoryStore());
    await c.upload('Toke', { pack: 'my-pack', icons: pics(1) });
    assert.equal(validPatch(patch as any), true);
    await c.remove('Toke', 'my-pack');
    assert.equal(validPatch(patch as any), false);
  });
});

describe('custom icons over HTTP', () => {
  it('lets the owner and a dev upload, refuses players and guests, serves the files, lets only the owner delete', async () => {
    const prev = process.env.ARENA_OWNER_CODE;
    process.env.ARENA_OWNER_CODE = 'icon-code';
    const store = new MemoryStore();
    const acc = new Accounts(store, 'icon-code');
    const toke = (await acc.register('Toke', 'hunter22', '1.1.1.1', 'icon-code')) as any;
    assert.ok((await acc.ownerUnlock(toke.token, toke.account, 'icon-code', '1.1.1.1')).ok);
    const dee = (await acc.register('Dee', 'hunter22', '2.2.2.2')) as any;
    assert.ok((await acc.adminSet('Dee', { grants: ['dev'] })).ok);
    const bob = (await acc.register('Bob', 'hunter22', '3.3.3.3')) as any;
    const srv = await startServer({ port: 0, host: '127.0.0.1', staticDir: '/nonexistent', accountStore: store });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (token: string | null, pack: string, n = 2) => fetch(`${base}/api/icons/custom`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ pack, icons: pics(n) }) });
    try {
      assert.deepEqual(await (await fetch(`${base}/api/icons/custom`)).json(), { packs: [], icons: [] });
      assert.equal((await post(null, 'guest-pack')).status, 401);
      assert.equal((await post('not-a-real-session-token', 'guest-pack')).status, 401);
      assert.equal((await post(bob.token, 'bob-pack')).status, 403, 'a normal player');
      assert.equal((await post(dee.token, 'dev-pack')).status, 200);
      assert.equal((await post(toke.token, 'owner-pack', 3)).status, 200);
      assert.equal((await post(toke.token, 'owner-pack')).status, 409);
      assert.equal((await post(toke.token, 'Bad Name')).status, 400);
      const l = (await (await fetch(`${base}/api/icons/custom`)).json()) as any;
      assert.deepEqual(l.packs.map((p: any) => [p.id, p.count]), [['dev-pack', 2], ['owner-pack', 3]]);
      assert.equal(l.icons.length, 5);
      // served from the store when the static folder has no such file
      const f = await fetch(`${base}${l.icons[0].file}`);
      assert.equal(f.status, 200);
      assert.equal(f.headers.get('content-type'), 'image/webp');
      assert.deepEqual(Buffer.from(await f.arrayBuffer()), real);
      assert.equal((await fetch(`${base}/icons/dev-pack/nothing.webp`)).status, 404);
      // delete: owner only
      const del = (token: string, pack: string) => fetch(`${base}/api/icons/custom/${pack}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      assert.equal((await del(dee.token, 'owner-pack')).status, 403, 'a dev cannot delete');
      assert.equal((await del(bob.token, 'owner-pack')).status, 403);
      assert.equal((await del(toke.token, 'owner-pack')).status, 200);
      assert.equal((await del(toke.token, 'owner-pack')).status, 404);
      assert.deepEqual(((await (await fetch(`${base}/api/icons/custom`)).json()) as any).packs.map((p: any) => p.id), ['dev-pack']);
      const log = await new AdminLog(store).list();
      assert.deepEqual(log.map((r) => `${r.by}:${r.action}`).reverse(), ['Dee:uploaded an icon pack', 'Toke:uploaded an icon pack', 'Toke:deleted an icon pack']);
    } finally {
      await srv.close();
      setCustomIcons([], []);
      if (prev === undefined) delete process.env.ARENA_OWNER_CODE;
      else process.env.ARENA_OWNER_CODE = prev;
    }
  });
});
