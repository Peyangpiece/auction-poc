// データの保存先（Cloudflare R2）への出し入れ。コンテナの中のアプリ（server/src/persist.js）だけが呼ぶ。
//   GET /manifest　　GET /file/<path>　　PUT /file/<path>　　DELETE /file/<path>
const PREFIX = 'data/';

export async function handleStore(request, bucket) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/manifest') {
    const files = [];
    let cursor;
    do {
      const page = await bucket.list({ prefix: PREFIX, cursor });
      for (const o of page.objects) files.push({ path: o.key.slice(PREFIX.length), size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return Response.json({ files });
  }
  if (!url.pathname.startsWith('/file/')) return new Response('not found', { status: 404 });
  const rel = decodeURIComponent(url.pathname.slice('/file/'.length));
  if (!rel || rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return new Response('bad path', { status: 400 });
  const key = PREFIX + rel;
  if (request.method === 'GET') {
    const obj = await bucket.get(key);
    return obj ? new Response(obj.body) : new Response('not found', { status: 404 });
  }
  if (request.method === 'PUT') {
    // 大きさが分かる形にしてから置く
    await bucket.put(key, await request.arrayBuffer());
    return Response.json({ ok: true });
  }
  if (request.method === 'DELETE') {
    await bucket.delete(key);
    return Response.json({ ok: true });
  }
  return new Response('method not allowed', { status: 405 });
}
