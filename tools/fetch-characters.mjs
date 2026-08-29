/**
 * 公式ポータルサイトのキャラクターページから、配布アイコンの一覧を data/characters.js に書き出す。
 *
 *   node tools/fetch-characters.mjs
 *
 * 生成されるのは「名前・カテゴリ・スリーサイズのバスト・イメージカラー・アイコンの URL」だけで、
 * 画像は含まない。グループ分けの範囲は items.js の BUST_GROUPS で決める。
 * ゲームは実行時にこの URL から直接アイコンを読み込む。
 * 公式サイトのキャラクターが増えたら実行し直せば追従できる。
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';

const SOURCE = 'https://umamusume.jp/character/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'characters.js');

function get(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/** Nuxt の payload（インデックス参照で圧縮された配列）を展開する */
function makeResolver(flat) {
  return function resolve(i, depth = 0) {
    if (depth > 14) return null;
    const v = flat[i];
    if (typeof v === 'number') return resolve(v, depth + 1);
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = resolve(v[k], depth + 1);
      return o;
    }
    return v;
  };
}

(async () => {
  const html = await get(SOURCE);
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NUXT_DATA__ が見つかりません。公式サイトの構造が変わった可能性があります。');

  const flat = JSON.parse(m[1]);
  const resolve = makeResolver(flat);
  const seen = new Set();
  const roster = [];

  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!('name' in v) || !('download' in v)) continue;

    const o = resolve(i);
    const url = o.download && o.download.icon && o.download.icon.url;
    if (!url) continue;

    const id = url.split('/').pop().replace(/_icon\.png$/, '');
    if (seen.has(id)) continue;
    seen.add(id);

    // size は "B81・W56・H81" 形式。ウマ娘以外（トレセン学園関係者）には無い
    const bust = /B(\d+)/.exec(o.size || '');

    roster.push({
      id,
      name: o.name,
      en: o.en || '',
      category: (o.category && o.category[0]) || 'その他',
      bust: bust ? Number(bust[1]) : null,
      color: o.color_main || '#8e9aab',
      icon: url,
    });
  }

  if (!roster.length) throw new Error('アイコンを 1 件も取得できませんでした。');

  const lines = roster.map((c) => '  ' + JSON.stringify(c) + ',');
  const src = [
    '/**',
    ' * 公式ポータルサイト（' + SOURCE + '）で配布されている SNS 用アイコンの一覧。',
    ' * tools/fetch-characters.mjs で自動生成。手で編集しない。',
    ' *',
    ' * 画像は同梱せず、実行時にこの icon の URL から直接読み込む。',
    ' * bust は公式プロフィールのスリーサイズの B 値（トレセン学園関係者は null）。',
    ' * グループ分けの範囲は items.js の BUST_GROUPS が持つ。',
    ' * 生成日時: ' + new Date().toISOString(),
    ' */',
    'const ROSTER = [',
    ...lines,
    '];',
    '',
  ].join('\n');

  writeFileSync(OUT, src);
  console.log('書き出し: ' + OUT);
  console.log(roster.length + ' 件');
  for (const g of new Set(roster.map((c) => c.category))) {
    console.log('  ' + g + ': ' + roster.filter((c) => c.category === g).length);
  }
  const busts = roster.map((c) => c.bust).filter((b) => b !== null);
  console.log('  バスト取得: ' + busts.length + ' 件（B' + Math.min(...busts) + '〜B' + Math.max(...busts) + '）');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
