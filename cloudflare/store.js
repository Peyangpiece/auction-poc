// データの保存先への出し入れ。コンテナの中のアプリ（server/src/persist.js・journal.js）だけが呼ぶ。
//   GET /manifest　　GET /file/<path>　　PUT /file/<path>　　DELETE /file/<path>
// 置き場は2つ:
//   - R2（bucket）: データベースの写し、日ごとの控え、請求書などのファイル
//   - 速い置き場（fast。入口の Durable Object の保存）: 書き込みの控え（journal/）。
//     入札のたびに書くので、速さが要る（R2 は、1回の書き込みに 0.2〜0.3 秒かかった。報告書 114.3・115 章）
const PREFIX = 'data/';
const FAST_PREFIX = 'journal/';

export async function handleStore(request, bucket, fast = null) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/manifest') {
    const files = new Map();
    let cursor;
    do {
      const page = await bucket.list({ prefix: PREFIX, cursor });
      for (const o of page.objects) files.set(o.key.slice(PREFIX.length), o.size);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // 速い置き場が答えないときも、一覧は返す（ここで止めると、起動のときの復元が止まる）。控えは、やり直せないだけ
    if (fast) { try { for (const f of await fast.list()) files.set(f.key, f.size); } catch (e) { console.error('[store] 速い置き場の一覧を取れません', e?.message ?? e); } }
    return Response.json({ files: [...files].map(([path, size]) => ({ path, size })) });
  }
  if (!url.pathname.startsWith('/file/')) return new Response('not found', { status: 404 });
  const rel = decodeURIComponent(url.pathname.slice('/file/'.length));
  if (!rel || rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return new Response('bad path', { status: 400 });
  const key = PREFIX + rel;
  const quick = fast && rel.startsWith(FAST_PREFIX);
  if (request.method === 'GET') {
    if (quick) {
      const hit = await fast.get(rel).catch(() => null);
      if (hit) return new Response(hit);
      // 無ければ、R2 も見る（前の版が、R2 に置いた控えが残っていることがある）
    }
    const obj = await bucket.get(key);
    return obj ? new Response(obj.body) : new Response('not found', { status: 404 });
  }
  if (request.method === 'PUT') {
    // 大きさが分かる形にしてから置く
    const body = await request.arrayBuffer();
    if (quick) await fast.put(rel, body); else await bucket.put(key, body);
    return Response.json({ ok: true });
  }
  if (request.method === 'DELETE') {
    if (quick) await fast.delete(rel).catch(() => {});
    await bucket.delete(key);
    return Response.json({ ok: true });
  }
  return new Response('method not allowed', { status: 405 });
}
