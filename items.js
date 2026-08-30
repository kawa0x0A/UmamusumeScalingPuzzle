/**
 * 進化チェーンの構成。
 *
 * 登場するキャラクターは data/characters.js（公式サイトから生成した一覧）から選ぶ。
 * 選択内容は localStorage に保存され、設定画面からいつでも変更できる。
 * アイコン画像は同梱せず、実行時に公式配布 URL から直接読み込む。
 */

/**
 * 11 段階の半径（px, 論理座標）。小さい順。
 * 段階数は下の BUST_GROUPS の数と一致させること（n 段階目 = n 番目のグループ）。
 */
const SIZES = [16, 22, 29, 36, 44, 53, 63, 74, 85, 98, 111];

/** ドロップ対象になるのは小さい方から 5 種類まで */
const DROPPABLE = 5;

/** 初期構成。各段階のバストサイズグループから 1 人ずつ */
const DEFAULT_PICKS = [
  'silencesuzuka',   // B70
  'haruurara',       // B74
  'tokaiteio',       // B77
  'nicenature',      // B79
  'specialweek',     // B81
  'oguricap',        // B82
  'kitasanblack',    // B85
  'symbolirudolf',   // B86
  'goldship',        // B88
  'maruzensky',      // B92
  'hishiakebono',    // B99
];

/** CDN 側でリサイズして受け取る幅（盤面用 / 一覧のサムネイル用） */
const ICON_W = 320;
const THUMB_W = 96;

const PICKS_KEY = 'uma-suika-picks';
const FREE_KEY = 'uma-suika-freemode';

/**
 * 選択画面のグループ分け。公式プロフィールのスリーサイズ B 値の範囲で区切る。
 * [下限, 上限]（どちらも含む）。ここを書き換えれば区切りを変えられる。
 */
const BUST_GROUPS = [
  [66, 71], [72, 75], [76, 77], [78, 79], [80, 81], [82, 83],
  [84, 85], [86, 87], [88, 89], [90, 92], [93, 99],
];

/** 上の範囲から外れた小さい方の受け皿 */
const BUST_UNDER_LABEL = 'B' + (BUST_GROUPS[0][0] - 1) + '以下';
/** スリーサイズが公開されていない面々（トレセン学園関係者） */
const NO_BUST_LABEL = 'トレセン学園関係者';

function groupOf(c) {
  if (c.bust === null || c.bust === undefined) return NO_BUST_LABEL;
  const range = BUST_GROUPS.find(([lo, hi]) => c.bust >= lo && c.bust <= hi);
  if (range) return 'B' + range[0] + '-' + range[1];
  return c.bust < BUST_GROUPS[0][0] ? BUST_UNDER_LABEL : 'B' + BUST_GROUPS[BUST_GROUPS.length - 1][1] + '超';
}

// 各キャラにグループを割り当て、タブの並び順を作る
ROSTER.forEach((c) => { c.group = groupOf(c); });

const ROSTER_GROUPS = [
  BUST_UNDER_LABEL,
  ...BUST_GROUPS.map(([lo, hi]) => 'B' + lo + '-' + hi),
  'B' + BUST_GROUPS[BUST_GROUPS.length - 1][1] + '超',
  NO_BUST_LABEL,
].filter((g) => ROSTER.some((c) => c.group === g));   // 該当者がいないタブは出さない

/** 段階に対応するグループ（スリーサイズの記載がない面々は段階を持たない） */
const STAGE_GROUPS = ROSTER_GROUPS.filter((g) => g !== NO_BUST_LABEL);

/** roster を id で引くための索引 */
const ROSTER_BY_ID = new Map(ROSTER.map((c) => [c.id, c]));

/** 合体してその段階になったときの獲得点（1,3,6,10,...） */
function mergeScore(type) {
  return ((type + 1) * (type + 2)) / 2;
}

/** アイコンの URL。imgix でリサイズできるので必要な大きさだけ取る */
function iconUrl(id, width) {
  const c = ROSTER_BY_ID.get(id);
  return c ? c.icon + '?w=' + width + '&fm=png' : '';
}

/** 保存された選択を読む。壊れていたら初期構成に戻す */
function loadPicks() {
  try {
    const raw = JSON.parse(localStorage.getItem(PICKS_KEY));
    if (Array.isArray(raw) && raw.length === SIZES.length && raw.every((id) => ROSTER_BY_ID.has(id))) {
      return raw;
    }
  } catch (_) { /* 壊れていれば初期構成 */ }
  return DEFAULT_PICKS.slice();
}

/** 選び方モード（false: 段階別 / true: 全員から選ぶ）を覚えておく */
function loadFreeMode() {
  try {
    return localStorage.getItem(FREE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function saveFreeMode(on) {
  try {
    localStorage.setItem(FREE_KEY, on ? '1' : '0');
  } catch (_) { /* 保存できなくても遊べる */ }
}

function savePicks(ids) {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(ids));
  } catch (_) { /* 保存できなくても遊べる */ }
}

/** id の並びから、盤面が使う ITEMS を組み立てる */
function buildItems(ids) {
  return ids.map((id, i) => {
    const c = ROSTER_BY_ID.get(id) || { id, name: '???', color: '#8e9aab' };
    return { id: c.id, name: c.name, color: c.color, r: SIZES[i] };
  });
}

/** 現在の進化チェーン。設定を変更すると差し替わる */
let ITEMS = buildItems(loadPicks());
