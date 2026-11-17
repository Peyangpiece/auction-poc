// メールの送信（Resend）。コンテナの中のアプリ（server/src/mvp/notify.js）だけが呼ぶ。
//   POST /send  { to, subject, text }
// API キー（RESEND_API_KEY）と、送り元（MAIL_FROM。例: 令和の競り <no-reply@example.co.jp>）は、秘密の値として Worker に置く。
export async function handleMail(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/send') return new Response('not found', { status: 404 });
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return Response.json({ ok: false, error: 'メールの送信が、設定されていません' }, { status: 503 });
  let m;
  try { m = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  const to = String(m?.to ?? ''), subject = String(m?.subject ?? ''), text = String(m?.text ?? '');
  // 宛先は1つだけ。改行を含む宛先・件名は断る（ヘッダーへの書き足しを防ぐ）
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(to) || !subject || /[\r\n]/.test(subject) || !text) return Response.json({ ok: false, error: 'bad message' }, { status: 400 });
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    // 送信サービスの返事のうち、理由だけを返す（API キーは含まれない）
    const detail = (await res.text()).slice(0, 300);
    return Response.json({ ok: false, error: `送信サービスが ${res.status} を返しました`, detail }, { status: 502 });
  }
  await res.body?.cancel();
  return Response.json({ ok: true });
}
