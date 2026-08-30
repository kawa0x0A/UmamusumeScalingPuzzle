(() => {
'use strict';

const { Engine, Bodies, Composite, Events } = Matter;

// --- 盤面定数（論理座標。CSS で拡大縮小される） ---
const W = 480;
const H = 680;
const WALL = 22;              // 壁の内側までの厚み
const DROP_Y = 66;            // 持ち駒の高さ
const LINE_Y = 128;           // デッドライン
const LEFT = WALL, RIGHT = W - WALL, FLOOR = H - WALL;
const DROP_COOLDOWN = 380;    // ms
const OVER_GRACE = 1300;      // ライン超過を許容する時間 ms

// U 字ケース：両側は垂直、下半分は内寸いっぱいの半円
const BOWL_R = (RIGHT - LEFT) / 2;
const BOWL_CX = W / 2;
const BOWL_CY = FLOOR - BOWL_R;   // 直線部と円弧のつなぎ目
const BOWL_SEGMENTS = 40;         // 円弧を近似する静的壁の枚数

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next');
const nextCtx = nextCanvas.getContext('2d');

const el = {
  score: document.getElementById('score'),
  best: document.getElementById('best'),
  nextName: document.getElementById('next-name'),
  overlay: document.getElementById('overlay'),
  finalScore: document.getElementById('final-score'),
  overTitle: document.getElementById('over-title'),
  restart: document.getElementById('restart'),
  sound: document.getElementById('sound-toggle'),
  retry: document.getElementById('retry'),
  chart: document.getElementById('chart'),
  notice: document.getElementById('notice'),
  audioNotice: document.getElementById('audio-notice'),
  settingsOpen: document.getElementById('settings-open'),
  toTitle: document.getElementById('to-title'),
  shareX: document.getElementById('share-x'),
  saveImage: document.getElementById('save-image'),
  overNote: document.getElementById('over-note'),
  slots: document.getElementById('slots'),
  leadHint: document.getElementById('lead-hint'),
  search: document.getElementById('search'),
  picker: document.getElementById('picker'),
  pickCount: document.getElementById('pick-count'),
  pickDefault: document.getElementById('pick-default'),
  pickRandom: document.getElementById('pick-random'),
  modeFree: document.getElementById('mode-free'),
  title: document.getElementById('title'),
  titleLead: document.querySelector('.title-lead'),
  start: document.getElementById('start'),
};

// --- 状態 ---
let engine, world;
let items = [];          // 落下済みの body 一覧
let heldType = 0, nextType = 0;
let heldX = W / 2, aimX = W / 2;
let lastDrop = -Infinity;
let score = 0;
let best = Number(localStorage.getItem('uma-suika-best') || 0);
let over = false;
let overTimer = 0;
let unlocked = 0;        // 到達した最大段階
let effects = [];        // 合体エフェクト
let popups = [];         // スコア表示
let shake = 0;
let mergeQueue = [];
// 'paused' は「プレイ中にメンバー変更を開いた」状態。盤面もスコアもそのまま残す
let phase = 'title';      // 'title' | 'playing' | 'paused' | 'over'

// ------------------------------------------------------------------ アイコン
// 公式配布アイコンを CDN の URL から直接読み込む（画像はリポジトリに持たない）。
// 読み込めない間・失敗した段階は、キャラクターのイメージカラーの円で代替する。
let icons = [];

function loadIcons() {
  icons = ITEMS.map(() => null);
  el.notice.hidden = true;
  ITEMS.forEach((item, i) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      icons[i] = img;
      drawNext();
      renderChart();
    };
    img.onerror = () => { el.notice.hidden = false; };
    img.src = iconUrl(item.id, ICON_W);
  });
}

// ------------------------------------------------------------------ 音
// 実際の生成は audio.js（UmaAudio）。ここでは呼び出しと音量だけ持つ。
const BGM_VOLUME = 0.35;
let muted = localStorage.getItem('uma-suika-muted') === '1';

function applyMute() {
  UmaAudio.setMuted(muted);
}

function startBgm() {
  UmaAudio.startBgm(BGM_VOLUME);
}

function stopBgm() {
  UmaAudio.stopBgm();
}

/**
 * 出力が止まっているあいだだけ案内を出す。
 * iOS は裏に回る・着信・Siri などで勝手に止まり、画面操作の中でしか起こせない。
 */
function updateAudioNotice() {
  const shouldPlay = !muted && (phase === 'playing' || phase === 'paused');
  el.audioNotice.hidden = !(shouldPlay && UmaAudio.state() && UmaAudio.state() !== 'running');
}

UmaAudio.setStateListener(updateAudioNotice);

// 止まっていたら、どこを触っても起こす（iOS は操作の中でしか resume できない）
document.addEventListener('pointerdown', () => {
  if (UmaAudio.state() && UmaAudio.state() !== 'running') {
    UmaAudio.init();
    if (phase === 'playing') UmaAudio.resumeBgm(BGM_VOLUME);
  }
}, { capture: true, passive: true });

const sfx = {
  drop: () => UmaAudio.drop(),
  merge: (stage) => UmaAudio.merge(stage),
  finish: () => UmaAudio.finish(),
};

// ------------------------------------------------------------------ 初期化
function setupWorld() {
  engine = Engine.create();
  engine.gravity.y = 1.15;
  engine.positionIterations = 8;
  engine.velocityIterations = 8;
  world = engine.world;

  const opt = { isStatic: true, friction: 0.4, restitution: 0.05 };
  const walls = [
    Bodies.rectangle(LEFT - 200, H / 2, 400, H * 2, opt),         // 左の直線壁
    Bodies.rectangle(RIGHT + 200, H / 2, 400, H * 2, opt),        // 右の直線壁
  ];

  // 半円の底。短い板を少しずつ重ねて並べ、すり抜けないようにする
  const t = 40;
  const seg = (Math.PI * BOWL_R / BOWL_SEGMENTS) * 1.8;
  for (let i = 0; i < BOWL_SEGMENTS; i++) {
    const a = Math.PI * (1 - (i + 0.5) / BOWL_SEGMENTS);   // π → 0（下側を通る）
    walls.push(Bodies.rectangle(
      BOWL_CX + Math.cos(a) * (BOWL_R + t / 2),
      BOWL_CY + Math.sin(a) * (BOWL_R + t / 2),
      seg, t,
      Object.assign({ angle: a + Math.PI / 2 }, opt)
    ));
  }
  Composite.add(world, walls);

  Events.on(engine, 'collisionStart', (ev) => {
    for (const pair of ev.pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      if (a.uma) a.uma.landed = true;
      if (b.uma) b.uma.landed = true;
      if (!a.uma || !b.uma) continue;
      if (a.uma.merged || b.uma.merged) continue;
      if (a.uma.type !== b.uma.type) continue;
      a.uma.merged = b.uma.merged = true;
      mergeQueue.push([a, b]);
    }
  });
}

function reset() {
  if (engine) Engine.clear(engine);
  items = [];
  effects = [];
  popups = [];
  mergeQueue = [];
  score = 0;
  over = false;
  overTimer = 0;
  unlocked = 0;
  shake = 0;
  lastDrop = -Infinity;
  disarmRetry();
  setupWorld();
  heldType = randomType();
  nextType = randomType();
  el.overlay.classList.add('hidden');
  updateHud();
  renderChart();
}

function randomType() {
  return Math.floor(Math.random() * DROPPABLE);
}

/** タイトル（＝メンバー選択画面）へ戻す。盤面は捨てて最初から */
function showTitle() {
  phase = 'title';
  stopBgm();
  reset();
  showPicker(false);
}

/**
 * ⚙ 出走メンバー。プレイ中なら時間を止めて開き、
 * 再開時にアイコンだけ差し替える（スコアも盤面も引き継ぐ）。
 */
function openPicker() {
  if (phase === 'playing') {
    phase = 'paused';
    disarmRetry();
    UmaAudio.pauseBgm();
    showPicker(true);
    return;
  }
  showTitle();
}

/** メンバー選択画面を出す。resuming = プレイ中に開いたので盤面を残す */
function showPicker(resuming) {
  draft = ITEMS.map((it) => it.id);
  renderMode();
  selectSlot(0);
  el.start.textContent = resuming ? '再開' : 'スタート';
  if (el.titleLead) {
    el.titleLead.textContent = resuming
      ? 'アイコンを入れ替えて、そのまま再開できます'
      : '同じウマ娘をくっつけて、大きく育てよう';
  }
  el.title.classList.remove('hidden');
}

/**
 * 選んだ顔ぶれを反映する。段階ごとの大きさは SIZES で決まっていて
 * 顔ぶれによらないので、落ちている球はそのまま使える。
 * 差し替えたら true。
 */
function applyDraft() {
  const ids = draft.filter(Boolean);
  if (ids.join() === ITEMS.map((it) => it.id).join()) return false;
  savePicks(ids);
  ITEMS = buildItems(ids);
  loadIcons();
  return true;
}

/**
 * タイトルからの遷移。選んだメンバーを確定し、
 * ワイプのジングルを鳴らして BGM を流し始める。
 */
function startRun() {
  if (draft.filter(Boolean).length !== SIZES.length) return;
  if (phase === 'paused') { resumeRun(); return; }

  applyDraft();
  UmaAudio.init();
  UmaAudio.fanfareStart();
  startBgm();
  el.title.classList.add('hidden');
  reset();
  phase = 'playing';
  setTimeout(updateAudioNotice, 400);
}

/** メンバー変更から戻る。アイコンと名前だけ入れ替えて続きを遊ぶ */
function resumeRun() {
  if (applyDraft()) {
    updateHud();      // 「つぎ」の絵と名前
    renderChart();
  }
  el.title.classList.add('hidden');
  phase = 'playing';
  last = performance.now();   // 止めていたぶんの経過時間を持ち込まない
  acc = 0;
  UmaAudio.init();
  UmaAudio.resumeBgm(BGM_VOLUME);
}

// ------------------------------------------------------------------ やり直し
// キーボードのない端末でも押せるようにボタンを置いてある。
// 進行中のプレイを消してしまうので、誤操作よけに 2 度押しで確定する。
const RETRY_CONFIRM = 4000;   // 1 度目の押下が有効な時間 ms
let retryArmed = 0;

function setRetryArmed(on) {
  el.retry.textContent = on ? '↻ もう一度押すと最初から' : '↻ やり直し';
  el.retry.classList.toggle('armed', on);
}

function disarmRetry() {
  if (!retryArmed) return;
  retryArmed = 0;
  setRetryArmed(false);
}

function requestRetry() {
  if (phase !== 'playing' && phase !== 'over') return;

  // まだ何もしていない盤面と、終わったあとは確認せずにやり直す
  const fresh = phase === 'over' || (items.length === 0 && score === 0);
  if (fresh || performance.now() - retryArmed < RETRY_CONFIRM) {
    disarmRetry();
    startRun();
    return;
  }

  const at = retryArmed = performance.now();
  setRetryArmed(true);
  setTimeout(() => { if (retryArmed === at) disarmRetry(); }, RETRY_CONFIRM);
}

// ------------------------------------------------------------------ 操作
function clampX(x, type) {
  const r = ITEMS[type].r;
  return Math.max(LEFT + r + 1, Math.min(RIGHT - r - 1, x));
}

function canDrop() {
  return phase === 'playing' && performance.now() - lastDrop >= DROP_COOLDOWN;
}

function drop() {
  if (!canDrop()) return;
  UmaAudio.init();
  const type = heldType;
  const x = clampX(heldX, type);
  spawn(type, x, DROP_Y, { fresh: true });
  lastDrop = performance.now();
  heldType = nextType;
  nextType = randomType();
  sfx.drop();
  updateHud();
}

function spawn(type, x, y, { fresh = false } = {}) {
  const item = ITEMS[type];
  const body = Bodies.circle(x, y, item.r, {
    restitution: 0.12,
    friction: 0.42,
    frictionStatic: 0.7,
    density: 0.0012,
    slop: 0.02,
  });
  body.uma = { type, merged: false, landed: !fresh, born: performance.now(), pop: fresh ? 1 : 0 };
  Composite.add(world, body);
  items.push(body);
  if (type > unlocked) { unlocked = type; renderChart(); }
  return body;
}

// ------------------------------------------------------------------ 合体処理
function resolveMerges() {
  if (!mergeQueue.length) return;
  const queue = mergeQueue;
  mergeQueue = [];

  for (const [a, b] of queue) {
    const type = a.uma.type;
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;
    removeBody(a);
    removeBody(b);

    const gained = mergeScore(type);
    score += gained;
    popups.push({ x, y, text: '+' + gained, life: 1 });
    burst(x, y, ITEMS[type].color, 14 + type * 2);
    shake = Math.min(14, 3 + type * 1.1);

    if (type < ITEMS.length - 1) {
      spawn(type + 1, x, y);
      sfx.merge(type);
    } else {
      // 最大同士 → 消滅（大量ボーナス）
      score += 500;
      popups.push({ x, y: y - 34, text: 'FINALS!! +500', life: 1.6 });
      burst(x, y, '#fff1b8', 46);
      shake = 20;
      sfx.finish();
    }
  }
  updateHud();
}

function removeBody(body) {
  Composite.remove(world, body);
  const i = items.indexOf(body);
  if (i >= 0) items.splice(i, 1);
}

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 4.5;
    effects.push({
      x, y, color,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 1,
      life: 1,
      size: 2 + Math.random() * 4,
    });
  }
}

// ------------------------------------------------------------------ 敗北判定
function checkOver(dt) {
  if (over) return;
  let breach = false;
  for (const b of items) {
    if (!b.uma.landed) continue;
    if (performance.now() - b.uma.born < 900) continue;  // 落下直後は猶予
    const top = b.position.y - b.circleRadius;
    const speed = Math.hypot(b.velocity.x, b.velocity.y);
    if (top < LINE_Y && speed < 1.2) { breach = true; break; }
  }
  overTimer = breach ? overTimer + dt : Math.max(0, overTimer - dt * 2);
  if (overTimer >= OVER_GRACE) gameOver();
}

function gameOver() {
  over = true;
  phase = 'over';
  stopBgm();
  const isBest = score > best;
  best = Math.max(best, score);
  localStorage.setItem('uma-suika-best', String(best));
  el.finalScore.textContent = String(score);
  el.overTitle.textContent = isBest ? '自己ベスト更新！' : 'リタイア...';
  el.overNote.hidden = true;
  el.overlay.classList.remove('hidden');
  updateHud();
  UmaAudio.fanfareEnd();
}

// ------------------------------------------------------------------ 描画
/** 円形に切り抜いたアイコンを (0,0) 中心・半径 r で描く。共通処理 */
function paintFace(c, type, r) {
  const item = ITEMS[type];
  const img = icons[type];

  c.save();
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.clip();

  if (img) {
    c.fillStyle = '#ffffff';
    c.fillRect(-r, -r, r * 2, r * 2);
    c.drawImage(img, -r, -r, r * 2, r * 2);
  } else {
    // アイコン未取得時のフォールバック
    const g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, item.color);
    c.fillStyle = g;
    c.fillRect(-r, -r, r * 2, r * 2);
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.font = '700 ' + (r * 0.9) + 'px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(item.name.charAt(0), 0, r * 0.04);
  }
  c.restore();

  // フチ
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.lineWidth = Math.max(2, r * 0.07);
  c.strokeStyle = item.color;
  c.stroke();
}

function drawItem(body) {
  const item = ITEMS[body.uma.type];
  const r = body.circleRadius;
  const scale = 1 + Math.sin(Math.min(1, body.uma.pop) * Math.PI) * 0.18;

  ctx.save();
  ctx.translate(body.position.x, body.position.y);

  // 影（回転させない）
  ctx.beginPath();
  ctx.arc(0, r * 0.12, r * scale, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(40,30,60,0.15)';
  ctx.fill();

  ctx.save();
  ctx.rotate(body.angle);
  ctx.scale(scale, scale);
  paintFace(ctx, body.uma.type, r);
  ctx.restore();

  // 大きい段階には名前を添える（本体と一緒に回さず水平に保つ）
  if (r >= 60) {
    const size = Math.max(11, Math.round(r * 0.17));
    ctx.font = '700 ' + size + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(item.name).width + size * 0.9;
    const y = r * 0.66;
    ctx.beginPath();
    ctx.roundRect(-w / 2, y - size * 0.72, w, size * 1.44, size);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fill();
    ctx.fillStyle = 'rgba(40,34,58,0.85)';
    ctx.fillText(item.name, 0, y);
  }
  ctx.restore();
}

/** U 字ケースの内側の輪郭 */
function bowlPath(c) {
  c.beginPath();
  c.moveTo(LEFT, -20);
  c.lineTo(LEFT, BOWL_CY);
  c.arc(BOWL_CX, BOWL_CY, BOWL_R, Math.PI, 0, true);   // 下側を通って右へ
  c.lineTo(RIGHT, -20);
  c.closePath();
}

function drawBoard() {
  // 枠（ケースの外側）
  ctx.fillStyle = '#eef2f8';
  ctx.fillRect(0, 0, W, H);

  // 内側（ターフ）
  ctx.save();
  bowlPath(ctx);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#eaf7ff');
  bg.addColorStop(0.45, '#f6fbf2');
  bg.addColorStop(1, '#dff0d8');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 内側の縁に薄い陰影をつけて厚みを出す
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(120,145,175,0.16)';
  bowlPath(ctx);
  ctx.stroke();
  ctx.restore();

  // ケースのフチ
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#9fb4c9';
  ctx.lineJoin = 'round';
  bowlPath(ctx);
  ctx.stroke();

  // デッドライン
  const danger = Math.min(1, overTimer / OVER_GRACE);
  ctx.save();
  ctx.setLineDash([12, 9]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(230,120,140,' + (0.5 + 0.5 * danger) + ')';
  ctx.beginPath();
  ctx.moveTo(LEFT, LINE_Y); ctx.lineTo(RIGHT, LINE_Y);
  ctx.stroke();
  ctx.restore();
  if (danger > 0.05) {
    ctx.fillStyle = 'rgba(255,80,90,' + (0.12 * danger) + ')';
    ctx.fillRect(LEFT, 0, RIGHT - LEFT, LINE_Y);
  }
}

function drawHeld() {
  if (phase !== 'playing') return;
  const ready = canDrop();
  const type = heldType;
  const r = ITEMS[type].r;
  const x = clampX(heldX, type);

  // ガイド
  ctx.save();
  ctx.setLineDash([6, 10]);
  ctx.strokeStyle = ready ? 'rgba(120,140,170,0.5)' : 'rgba(120,140,170,0.2)';
  ctx.lineWidth = 2;
  const dx = Math.abs(x - BOWL_CX);
  const bottom = BOWL_CY + (dx < BOWL_R ? Math.sqrt(BOWL_R * BOWL_R - dx * dx) : 0);
  ctx.beginPath();
  ctx.moveTo(x, DROP_Y + r);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.restore();

  ctx.globalAlpha = ready ? 1 : 0.4;
  drawItem({
    position: { x, y: DROP_Y }, angle: 0, circleRadius: r,
    uma: { type, pop: 1 },
  });
  ctx.globalAlpha = 1;
}

function drawEffects() {
  for (const p of effects) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const p of popups) {
    ctx.globalAlpha = Math.min(1, p.life);
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillStyle = '#ff5f7e';
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

function drawNext() {
  const size = 84;
  nextCtx.clearRect(0, 0, size, size);
  nextCtx.save();
  nextCtx.translate(size / 2, size / 2);
  paintFace(nextCtx, nextType, size * 0.4);
  nextCtx.restore();
  el.nextName.textContent = ITEMS[nextType].name;
}

// ------------------------------------------------------------------ HUD
function updateHud() {
  el.score.textContent = String(score);
  el.best.textContent = String(Math.max(best, score));
  drawNext();
}

function renderChart() {
  el.chart.innerHTML = '';
  ITEMS.forEach((item, i) => {
    const li = document.createElement('li');
    // 最初から全員ぶん出す。到達済みかどうかは濃さで示すだけ
    li.className = 'chart-item' + (i <= unlocked ? ' got' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.borderColor = item.color;
    const d = 18 + i * 2.4;
    dot.style.width = dot.style.height = d + 'px';
    dot.style.fontSize = Math.round(d * 0.55) + 'px';
    if (icons[i]) {
      dot.style.backgroundImage = 'url("' + icons[i].src + '")';
      dot.classList.add('has-icon');
    } else {
      // アイコンがまだ読めていないときだけ頭文字で代替する
      dot.style.background = item.color;
      dot.textContent = item.name.charAt(0);
    }
    const label = document.createElement('span');
    label.className = 'chart-label';
    label.textContent = item.name;
    li.append(dot, label);
    el.chart.appendChild(li);
  });
}

// ------------------------------------------------------------------ ループ
let last = performance.now();
let acc = 0;
const STEP = 1000 / 60;
const MAX_DT = 100;               // これ以上のコマ落ちは切り捨てる
const MAX_STEPS = Math.ceil(MAX_DT / STEP);

function frame(now) {
  const dt = Math.min(MAX_DT, now - last);
  last = now;

  // メンバー変更を開いている間は時間を止める（盤面はそのまま描き続ける）
  const frozen = phase === 'paused';

  if (!over && !frozen) {
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      Engine.update(engine, STEP);
      resolveMerges();
      acc -= STEP;
      steps++;
    }
    if (acc > STEP) acc = 0;
    checkOver(dt);
  }

  if (!frozen) {
    // 万一ケースの外へ抜けた球は捨てる
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].position.y > H + 300) removeBody(items[i]);
    }

    // 補間・寿命
    heldX += (aimX - heldX) * Math.min(1, dt / 60);
    for (const b of items) b.uma.pop = Math.min(1, b.uma.pop + dt / 220);
    effects = effects.filter((p) => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.life -= dt / 620;
      return p.life > 0;
    });
    popups = popups.filter((p) => { p.y -= dt / 26; p.life -= dt / 900; return p.life > 0; });
    shake *= Math.pow(0.86, dt / 16);
  }

  // 描画
  ctx.save();
  if (shake > 0.4) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  }
  drawBoard();
  for (const b of items) drawItem(b);
  drawHeld();
  drawEffects();
  ctx.restore();

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 入力
function pointerX(e) {
  const rect = canvas.getBoundingClientRect();
  return ((e.clientX - rect.left) / rect.width) * W;
}

canvas.addEventListener('pointermove', (e) => { aimX = clampX(pointerX(e), heldType); });
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture?.(e.pointerId); } catch (_) { /* 合成イベント等 */ }
  aimX = heldX = clampX(pointerX(e), heldType);
});
canvas.addEventListener('pointerup', (e) => { aimX = clampX(pointerX(e), heldType); drop(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  // 入力欄にいる間は盤面の操作を受け付けない
  if (e.target instanceof HTMLInputElement) return;
  // メンバー選択画面では Enter / Space だけ「スタート（再開）」として扱う
  if (phase === 'title' || phase === 'paused') {
    if (e.key === 'Enter' || e.key === ' ') { startRun(); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'a') { aimX = clampX(aimX - 26, heldType); e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'd') { aimX = clampX(aimX + 26, heldType); e.preventDefault(); }
  if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'Enter') {
    if (phase === 'playing') drop(); else startRun();
    e.preventDefault();
  }
  if (e.key === 'r' || e.key === 'R') requestRetry();
});

el.restart.addEventListener('click', startRun);
el.toTitle.addEventListener('click', showTitle);
el.shareX.addEventListener('click', shareToX);
el.saveImage.addEventListener('click', saveResultImage);
el.settingsOpen.addEventListener('click', openPicker);
el.retry.addEventListener('click', requestRetry);
el.start.addEventListener('click', startRun);
el.sound.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('uma-suika-muted', muted ? '1' : '0');
  el.sound.textContent = muted ? '🔇 音 OFF' : '🔊 音 ON';
  applyMute();
  if (!muted) UmaAudio.merge(4);
  updateAudioNotice();
});

// 裏に回っている間は BGM を止める
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { UmaAudio.pauseBgm(); return; }
  if (phase === 'playing') UmaAudio.resumeBgm(BGM_VOLUME);
  // resume は非同期なので、少し待ってから鳴っているか見る
  setTimeout(updateAudioNotice, 400);
});

// ------------------------------------------------------------------ 結果の共有
const SHARE_TITLE = 'ウマ娘パズルゲーム (ファンメイド)';
const SHARE_TAG = 'ウマ娘パズルゲーム';   // ハッシュタグに空白・括弧は使えないので短い方
// 公開先を直に持つ。手元やコピーから投稿しても、リンク先は公開版になる
const SHARE_URL = 'https://kawa0x0a.github.io/UmamusumeScalingPuzzle/';

function reachedName() {
  return ITEMS[unlocked] ? ITEMS[unlocked].name : '—';
}

function shareText() {
  return [
    SHARE_TITLE,
    'スコア ' + score + '（ベスト ' + Math.max(best, score) + '）',
    '最高到達: ' + reachedName(),
  ].join('\n');
}

function notify(message) {
  el.overNote.textContent = message;
  el.overNote.hidden = false;
}

/** X の投稿画面を開く。実際に投稿するかは X 側で本人が決める */
function shareToX() {
  const url = 'https://x.com/intent/post'
    + '?text=' + encodeURIComponent(shareText())
    + '&url=' + encodeURIComponent(SHARE_URL)
    + '&hashtags=' + encodeURIComponent(SHARE_TAG);
  window.open(url, '_blank', 'noopener,noreferrer');
  notify('X の投稿画面を開きました。画像を添えたい場合は「画像を保存」から。');
}

/** 盤面に見出しと結果を足した 1 枚の画像を作る */
function buildResultCanvas() {
  const pad = 18;
  const head = 108;
  const foot = 64;
  const out = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = W + pad * 2;
  const h = head + H + foot + pad;
  out.width = Math.round(w * dpr);
  out.height = Math.round(h * dpr);
  const c = out.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 背景
  const bg = c.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#242b40');
  bg.addColorStop(1, '#3d3357');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);

  // 見出し
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = 'rgba(255,255,255,0.6)';
  c.font = '600 13px system-ui, sans-serif';
  c.fillText(SHARE_TITLE, pad, 34);

  c.fillStyle = '#ffffff';
  c.font = '700 46px system-ui, sans-serif';
  c.fillText(String(score), pad, 84);
  const scoreW = c.measureText(String(score)).width;
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.font = '600 14px system-ui, sans-serif';
  c.fillText('points', pad + scoreW + 8, 84);

  c.textAlign = 'right';
  c.fillStyle = 'rgba(255,255,255,0.75)';
  c.font = '600 13px system-ui, sans-serif';
  c.fillText('ベスト ' + Math.max(best, score), w - pad, 56);
  c.fillText('最高到達 ' + reachedName(), w - pad, 78);

  // 盤面をそのまま貼る
  c.save();
  roundRectPath(c, pad, head, W, H, 14);
  c.clip();
  c.drawImage(canvas, pad, head, W, H);
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 2;
  roundRectPath(c, pad, head, W, H, 14);
  c.stroke();

  // 到達した段階のアイコンを添えて締める
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  const footY = head + H + foot / 2;
  const img = icons[unlocked];
  if (img) {
    const r = 20;
    c.save();
    c.beginPath();
    c.arc(pad + r, footY, r, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#fff';
    c.fillRect(pad, footY - r, r * 2, r * 2);
    c.drawImage(img, pad, footY - r, r * 2, r * 2);
    c.restore();
    c.beginPath();
    c.arc(pad + r, footY, r, 0, Math.PI * 2);
    c.strokeStyle = ITEMS[unlocked].color;
    c.lineWidth = 2.5;
    c.stroke();
  }
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.font = '700 15px system-ui, sans-serif';
  c.fillText(reachedName() + ' まで育成', pad + (img ? 50 : 0), footY);

  return out;
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function saveResultImage() {
  let out;
  try {
    out = buildResultCanvas();
  } catch (err) {
    notify('画像を作れませんでした: ' + err.message);
    return;
  }
  // アイコンは CORS 許可付きで読んでいるので通常は書き出せる
  out.toBlob((blob) => {
    if (!blob) {
      notify('画像を保存できませんでした。スクリーンショットをご利用ください。');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'uma-puzzle-' + score + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify('画像を保存しました。');
  }, 'image/png');
}

// ------------------------------------------------------------------ 出走メンバー設定
// n 段階目には n 番目のバストサイズグループから 1 人を割り当てる。
// タブと段階が 1 対 1 に対応しているので、枠は常に 11 人ぶん埋まっている。
let draft = [];              // 編集中の 11 枠
let activeSlot = 0;          // いま編集している段階
let query = '';
// false: 段階別（段階ごとのグループから 1 人ずつ）
// true : 全員から選ぶ（173 人の誰でも好きな段階へ）
let freeMode = loadFreeMode();

/** その段階に割り当てるべきグループ名 */
function groupForSlot(i) {
  return STAGE_GROUPS[Math.min(i, STAGE_GROUPS.length - 1)];
}

function selectSlot(i) {
  activeSlot = i;
  query = '';
  el.search.value = '';
  renderSlots(); renderPicker(); updateStageLabel();
}

function setFreeMode(on) {
  if (freeMode === on) return;
  freeMode = on;
  saveFreeMode(on);
  query = '';
  el.search.value = '';
  renderMode(); renderSlots(); renderPicker(); updateStageLabel();
}

function renderMode() {
  el.modeFree.checked = freeMode;
  if (el.leadHint) {
    el.leadHint.textContent = freeMode
      ? '上の枠で段階を選び、173 人から自由に。'
      : '上の枠で段階を選び、一覧から 1 人。';
  }
  el.search.placeholder = freeMode ? '173 人から名前で探す' : 'この段階の中から探す';
}

/**
 * いま一覧に出す顔ぶれ。
 * 段階別モードはその段階のグループだけ、全員モードは 173 人すべて。
 */
function visibleRoster() {
  const pool = freeMode
    ? ROSTER
    : ROSTER.filter((c) => c.group === groupForSlot(activeSlot));

  const q = query.trim();
  if (!q) return pool;
  const lower = q.toLowerCase();
  return pool.filter((c) => c.name.includes(q) || c.en.toLowerCase().includes(lower));
}

function renderSlots() {
  el.slots.innerHTML = '';
  SIZES.forEach((_, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (draft[i] ? ' filled' : '') + (i === activeSlot ? ' active' : '');
    const d = 26 + i * 3.4;
    b.style.width = b.style.height = d + 'px';

    const c = draft[i] ? ROSTER_BY_ID.get(draft[i]) : null;
    if (c) {
      b.style.backgroundImage = 'url("' + iconUrl(c.id, THUMB_W) + '")';
      b.style.borderColor = c.color;
      b.title = (i + 1) + '段階目: ' + c.name + ' — 押すとこの段階を編集';
    } else {
      b.textContent = String(i + 1);
      b.title = (i + 1) + '段階目 — 未選択';
    }
    b.addEventListener('click', () => selectSlot(i));
    li.appendChild(b);
    el.slots.appendChild(li);
  });
}

function renderPicker() {
  const list = visibleRoster();

  el.picker.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'modal-help';
    p.textContent = freeMode
      ? '該当するキャラクターがいません。'
      : 'この段階の候補にはいません。「全員から選ぶ」に切り替えると 173 人から選べます。';
    el.picker.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const c of list) {
    const at = draft.indexOf(c.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick' + (at >= 0 ? ' chosen' : '');
    b.title = at >= 0
      ? c.name + '（いま ' + (at + 1) + '段階目）'
      : c.name + ' を ' + (activeSlot + 1) + '段階目にする';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = iconUrl(c.id, THUMB_W);
    img.style.borderColor = c.color;
    const label = document.createElement('span');
    label.textContent = c.name;
    b.append(img, label);
    b.addEventListener('click', () => assignPick(c.id));
    frag.appendChild(b);
  }
  el.picker.appendChild(frag);
}

/** 選んだ 1 人を編集中の段階に入れる。他の段階にいた場合はそちらから外す */
function assignPick(id) {
  const at = draft.indexOf(id);
  if (at === activeSlot) return;
  if (at >= 0) draft[at] = draft[activeSlot];   // 重複しないよう入れ替え
  draft[activeSlot] = id;
  renderSlots(); renderPicker(); updateStageLabel();
}

function updateStageLabel() {
  const c = ROSTER_BY_ID.get(draft[activeSlot]);
  el.pickCount.textContent = (activeSlot + 1) + '段階目'
    + (c ? ' · ' + c.name : '');
  el.start.disabled = draft.filter(Boolean).length !== SIZES.length;
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 段階別モードは各段階のグループから 1 人ずつ。
 * 全員モードは 173 人から重複なしで 11 人。
 */
function randomPicks() {
  draft = freeMode
    ? shuffled(ROSTER).slice(0, SIZES.length).map((c) => c.id)
    : SIZES.map((_, i) => shuffled(ROSTER.filter((c) => c.group === groupForSlot(i)))[0].id);
  renderSlots(); renderPicker(); updateStageLabel();
}

el.search.addEventListener('input', () => {
  query = el.search.value;
  renderPicker();
});
el.modeFree.addEventListener('change', () => setFreeMode(el.modeFree.checked));
el.pickRandom.addEventListener('click', randomPicks);
el.pickDefault.addEventListener('click', () => {
  draft = DEFAULT_PICKS.slice();
  renderSlots(); renderPicker(); updateStageLabel();
});

// ------------------------------------------------------------------ 起動
function fitCanvas(cv, c2d, w, h) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fitAll() {
  fitCanvas(canvas, ctx, W, H);
  fitCanvas(nextCanvas, nextCtx, 84, 84);
  drawNext();
}
fitAll();
window.addEventListener('resize', fitAll);

// デバッグ／自動テスト用のフック
window.UmaGame = {
  reset,
  drop,
  startRun,
  showTitle,
  openPicker,
  requestRetry,
  get phase() { return phase; },
  audio: UmaAudio,
  get engine() { return engine; },
  get items() { return items; },
  get score() { return score; },
};

el.sound.textContent = muted ? '🔇 音 OFF' : '🔊 音 ON';
applyMute();
loadIcons();
showTitle();
requestAnimationFrame(frame);
})();
