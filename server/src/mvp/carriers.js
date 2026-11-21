// 運送会社（発注者の決定: ヤマト運輸と佐川急便の2社。連携は、取り込み用のファイルの書き出し。報告書 131 章）。
//
// 【大事】ここに書いた「標準の並び」は、公開されている資料の抜粋（ヤマトは公式のレイアウト資料の抜粋、佐川は連携サービスの資料）から起こしたもので、
// 運送会社のシステムに、実際に取り込んでは、確かめていない（どちらも、契約者だけが使える）。取り込めないときのために、
// 「項目名つきの簡単な形」も書き出せるようにしてある（運送会社のシステムの側で、列の対応付けを、一度だけ作って使う）。

/** 追跡: 伝票番号を付けて直接開く URL は、作らない。両社とも、形が変わった時期があり、いま有効な形を、確かめられなかった（報告書 131.4）。
 *  お知らせメールには、公式のサイトと、伝票番号を書く */
export const CARRIERS = {
  yamato: { name: 'ヤマト運輸', system: 'B2クラウド', pageName: '荷物お問い合わせ', page: 'https://www.kuronekoyamato.co.jp/' },
  sagawa: { name: '佐川急便', system: 'e飛伝Ⅲ', pageName: 'お荷物問い合わせサービス', page: 'https://www.sagawa-exp.co.jp/' },
};

/** 伝票番号: 数字だけにそろえる（ハイフン・空白・全角の数字を受ける）。数字が無ければ、空 */
export const normTracking = (v) => String(v ?? '').normalize('NFKC').replace(/[^0-9]/g, '').slice(0, 20);

/** 伝票番号を付けて、追跡のページを直接開く URL。形が確かめられた会社だけ返す（いまは、どちらも null） */
export function trackingUrl(carrier, tracking) {
  void carrier; void tracking;
  return null;
}

/** お客様管理番号: 取り込み用のファイルに入れ、運送会社のシステムが出す「発行済みのデータ」から、伝票番号を取り込むときの手がかりにする。半角の英数字だけ */
export const refOf = (eventId, accountId) => `E${eventId}M${accountId}`;
export const parseRef = (ref) => { const m = /^E(\d+)M(\d+)$/.exec(String(ref ?? '').normalize('NFKC').trim().toUpperCase()); return m ? { eventId: Number(m[1]), accountId: Number(m[2]) } : null; };

const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '');
/** 主催者の住所（設定。「〒123-4567」で始まり、改行できる）を、郵便番号と住所に分ける */
export function senderParts(address) {
  const text = String(address ?? '').replace(/\r/g, '');
  const m = /〒?\s*(\d{3})[-－ー]?(\d{4})/.exec(text);
  return { zip: m ? `${m[1]}-${m[2]}` : '', address: (m ? text.replace(m[0], '') : text).split('\n').map((t) => t.trim()).filter(Boolean).join(' ') };
}

// ---- ヤマト運輸 B2クラウド「基本レイアウト」（95列）。出どころ: 公式の「送り状発行データレイアウト 入出力用」の抜粋と、連携サービスの資料
// 列名のうち、10・56・90〜95 は、正確な表記を確かめられていない（基本レイアウトの取り込みは、列の位置で読むので、名前の違いは効かない見込み）
const YAMATO = ['お客様管理番号', '送り状種類', 'クール区分', '伝票番号', '出荷予定日', 'お届け予定（指定）日', '配達時間帯', 'お届け先コード', 'お届け先電話番号', 'お届け先電話番号枝番',
  'お届け先郵便番号', 'お届け先住所', 'お届け先住所（アパートマンション名）', 'お届け先会社・部門名１', 'お届け先会社・部門名２', 'お届け先名', 'お届け先名略称カナ', '敬称', 'ご依頼主コード', 'ご依頼主電話番号',
  'ご依頼主電話番号枝番', 'ご依頼主郵便番号', 'ご依頼主住所', 'ご依頼主住所（アパートマンション名）', 'ご依頼主名', 'ご依頼主略称カナ', '品名コード１', '品名１', '品名コード２', '品名２',
  '荷扱い１', '荷扱い２', '記事', 'コレクト代金引換額（税込）', 'コレクト内消費税額等', '営業所止置き', '営業所コード', '発行枚数', '個数口枠の印字', 'ご請求先顧客コード',
  'ご請求先分類コード', '運賃管理番号', 'クロネコwebコレクトデータ登録', 'クロネコwebコレクト加盟店番号', 'クロネコwebコレクト申込受付番号１', 'クロネコwebコレクト申込受付番号２', 'クロネコwebコレクト申込受付番号３', 'お届け予定ｅメール利用区分', 'お届け予定ｅメール e-mailアドレス', '入力機種',
  'お届け予定ｅメールメッセージ', 'お届け完了ｅメール利用区分', 'お届け完了ｅメール e-mailアドレス', 'お届け完了ｅメールメッセージ', 'クロネコ収納代行利用区分', '予備', '収納代行請求金額(税込)', '収納代行内消費税額等', '収納代行請求先郵便番号', '収納代行請求先住所',
  '収納代行請求先住所（アパートマンション名）', '収納代行請求先会社・部門名１', '収納代行請求先会社・部門名２', '収納代行請求先名(漢字)', '収納代行請求先名(カナ)', '収納代行問合せ先名', '収納代行問合せ先郵便番号', '収納代行問合せ先住所', '収納代行問合せ先住所（アパートマンション名）', '収納代行問合せ先電話番号',
  '収納代行管理番号', '収納代行品名', '収納代行備考', '複数口くくりキー', '検索キータイトル1', '検索キー1', '検索キータイトル2', '検索キー2', '検索キータイトル3', '検索キー3',
  '検索キータイトル4', '検索キー4', '検索キータイトル5', '検索キー5', '予備', '予備', '投函予定メール利用区分', '投函予定メール e-mailアドレス', '投函予定メールメッセージ', '投函完了メール（お届け先宛）利用区分',
  '投函完了メール（お届け先宛）e-mailアドレス', '投函完了メール（お届け先宛）メッセージ', '投函完了メール（ご依頼主宛）利用区分', '投函完了メール（ご依頼主宛）e-mailアドレス', '投函完了メール（ご依頼主宛）メッセージ'];

// ---- 佐川急便 e飛伝Ⅲ「標準_飛脚宅配便_CSV_ヘッダ有」（74列）。出どころ: 連携サービスの資料の突き合わせ（公式の一覧は、読めていない）。
// 45〜50 の並びと、69〜74 は、確かめられていない
const SAGAWA = ['お届け先コード取得区分', 'お届け先コード', 'お届け先電話番号', 'お届け先郵便番号', 'お届け先住所１', 'お届け先住所２', 'お届け先住所３', 'お届け先名称１', 'お届け先名称２', 'お客様管理番号',
  'お客様コード', '部署ご担当者コード取得区分', '部署ご担当者コード', '部署ご担当者名称', '荷送人電話番号', 'ご依頼主コード取得区分', 'ご依頼主コード', 'ご依頼主電話番号', 'ご依頼主郵便番号', 'ご依頼主住所１',
  'ご依頼主住所２', 'ご依頼主名称１', 'ご依頼主名称２', '荷姿', '品名１', '品名２', '品名３', '品名４', '品名５', '荷札荷姿',
  '荷札品名１', '荷札品名２', '荷札品名３', '荷札品名４', '荷札品名５', '荷札品名６', '荷札品名７', '荷札品名８', '荷札品名９', '荷札品名１０',
  '荷札品名１１', '出荷個数', 'スピード指定', 'クール便指定', '配達日', '配達指定時間帯', '配達指定時間（時分）', '代引金額', '消費税', '決済種別',
  '保険金額', '指定シール１', '指定シール２', '指定シール３', '営業所受取', 'SRC区分', '営業所受取営業所コード', '元着区分', 'メールアドレス', 'ご不在時連絡先',
  '出荷日', 'お問い合せ送り状No.', '出荷場印字区分', '集約解除指定', '編集０１', '編集０２', '編集０３', '編集０４', '編集０５', '編集０６',
  '編集０７', '編集０８', '編集０９', '編集１０'];

// ---- 項目名つきの簡単な形（どちらの会社でも同じ）。運送会社のシステムで、列の対応付け（取込パターン／テンプレート）を、一度だけ作って使う
const SIMPLE = ['お客様管理番号', '出荷予定日', 'お届け先名', '敬称', 'お届け先郵便番号', 'お届け先住所', 'お届け先電話番号', '品名', '個数', 'ご依頼主名', 'ご依頼主郵便番号', 'ご依頼主住所', 'ご依頼主電話番号', '会員番号', '点数', '記事'];

/** 住所を、決めた文字数ごとに分ける（佐川の、住所１〜３） */
const chunk = (text, size, n) => { const out = []; const chars = [...String(text ?? '')]; for (let i = 0; i < n; i++) out.push(chars.slice(i * size, (i + 1) * size).join('')); return out; };

/**
 * 取り込み用の表を作る。1人の顧客（1つの荷物）につき1行。
 * carrier: yamato / sagawa。form: standard（各社の標準の並び。未検証）/ simple（項目名つきの簡単な形）。
 * p: 開催の番号・出荷の予定日（YYYY-MM-DD）・顧客の一覧（会員番号・名前・郵便番号・住所・電話番号・品）・ご依頼主・運送会社の番号（設定）
 */
export function carrierRows(carrier, form, p) {
  const s = senderParts(p.sender.address);
  const date = p.shipDate.replaceAll('-', '/');
  // 品名: 送り状に出る。落札した品の名前を、つなげる（長いときは、切る）。「No.3 」のような品番は、外す
  const itemText = (c, max) => [...c.lines.map((l) => String(l.label).replace(/^No\.\d+\s*/, '')).join('・')].slice(0, max).join('');
  if (form === 'simple') {
    return { header: SIMPLE, rows: p.customers.map((c) => [refOf(p.eventId, c.accountId), date, c.name, '様', c.zip, c.address, c.phone, itemText(c, 50), 1,
      p.sender.name, s.zip, s.address, p.sender.tel, c.accountId, c.lines.length, `令和の競り ${date}`]) };
  }
  if (carrier === 'yamato') {
    const col = (name) => YAMATO.indexOf(name);
    return { header: YAMATO, rows: p.customers.map((c) => {
      const r = YAMATO.map(() => '');
      const set = (name, v) => { r[col(name)] = v ?? ''; };
      set('お客様管理番号', refOf(p.eventId, c.accountId));
      set('送り状種類', '0'); // 0 = 発払い
      set('出荷予定日', date);
      set('お届け先電話番号', c.phone); set('お届け先郵便番号', c.zip); set('お届け先住所', c.address); set('お届け先名', c.name); set('敬称', '様');
      set('ご依頼主電話番号', p.sender.tel); set('ご依頼主郵便番号', s.zip); set('ご依頼主住所', s.address); set('ご依頼主名', p.sender.name);
      set('品名１', itemText(c, 25));
      set('発行枚数', '1');
      set('ご請求先顧客コード', p.codes.yamatoBillingCode); set('運賃管理番号', p.codes.yamatoFareNo);
      return r;
    }) };
  }
  const col = (name) => SAGAWA.indexOf(name);
  return { header: SAGAWA, rows: p.customers.map((c) => {
    const r = SAGAWA.map(() => '');
    const set = (name, v) => { r[col(name)] = v ?? ''; };
    const [a1, a2, a3] = chunk(c.address, 16, 3);
    const [s1, s2] = chunk(s.address, 16, 2);
    set('お届け先電話番号', c.phone); set('お届け先郵便番号', c.zip); set('お届け先住所１', a1); set('お届け先住所２', a2); set('お届け先住所３', a3); set('お届け先名称１', c.name);
    set('お客様管理番号', refOf(p.eventId, c.accountId)); set('お客様コード', p.codes.sagawaCustomerCode);
    set('荷送人電話番号', p.sender.tel); set('ご依頼主電話番号', p.sender.tel); set('ご依頼主郵便番号', s.zip); set('ご依頼主住所１', s1); set('ご依頼主住所２', s2); set('ご依頼主名称１', p.sender.name);
    set('品名１', itemText(c, 16));
    set('出荷個数', '1');
    set('出荷日', digits(date));
    return r;
  }) };
}

/** 運送会社のシステムが出した「発行済みのデータ」（見出しの行つき）から、お客様管理番号と伝票番号の列を探す。列の位置ではなく、見出しの名前で探す */
export function findTrackingColumns(header) {
  const norm = (v) => String(v ?? '').normalize('NFKC').replace(/[\s　"']/g, '');
  const names = header.map(norm);
  const ref = names.findIndex((n) => n.includes('お客様管理番号'));
  const tracking = names.findIndex((n) => n === '伝票番号' || n.includes('送り状No') || n.includes('送り状番号') || n.includes('伝票番号'));
  return { ref, tracking };
}
