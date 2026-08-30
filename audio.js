/**
 * ゲーム中の音をすべて WebAudio で合成する。
 * 音源ファイルを持たないので、配布するときに素材の権利を気にしなくてよい。
 *
 * BGM は 120BPM・16 小節（32 秒）のループ。
 * 場面転換は開始／終了のファンファーレ、投下と合体は短い電子音。
 */
const UmaAudio = (() => {
  'use strict';

  // --- BGM の構成 ---
  const BPM = 120;
  const STEP = 60 / BPM / 2;      // 8 分音符ひとつぶん（0.25 秒）
  const STEPS_PER_BAR = 8;
  const BARS = 16;                // 16 小節 = 32 秒でループ
  const TOTAL_STEPS = BARS * STEPS_PER_BAR;

  const LOOKAHEAD_MS = 25;        // スケジューラの起動間隔
  const SCHEDULE_AHEAD = 0.25;    // 何秒先まで予約しておくか

  // BGM 各パートの音量。元音源の実測（RMS -32.7dB / ピーク -14.5dB＝控えめ）に
  // 寄せるため、全体をこの係数で絞ってから bgmBus の音量を掛ける。
  const MIX = 0.075;

  // コンプレッサー通過後の最終調整。元音源（実測 RMS -41.8dBFS）に合わせる係数
  const BGM_TRIM = 0.23;

  // C - Am - F - G を 4 小節ずつではなく 1 小節ずつ回す
  const PROGRESSION = [
    { root: 36, chord: [60, 64, 67], color: [72, 76, 79] },   // C
    { root: 33, chord: [57, 60, 64], color: [69, 72, 76] },   // Am
    { root: 41, chord: [57, 60, 65], color: [69, 72, 77] },   // F
    { root: 43, chord: [59, 62, 67], color: [71, 74, 79] },   // G
  ];

  // 小節内での上物の位置（8 分音符 8 個のうち鳴らす場所）
  const MELODY_PATTERN = [0, 3, 5, 0, 0, 3, 6, 0];

  let ctx = null;
  let master = null;
  let bgmBus = null;
  let sfxBus = null;
  let noiseBuffer = null;

  let muted = false;

  let timer = null;
  let stepIndex = 0;
  let nextStepTime = 0;
  let onState = null;      // 出力状態が変わったときの通知先（game.js が使う）

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // ------------------------------------------------------------ 準備
  function ac() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // iOS/WebKit はバックグラウンド・着信・Siri などで勝手に止まる
    // （'suspended' のほか WebKit 独自の 'interrupted' になる）。
    // 復帰したら予約時刻を今に合わせ直さないと、鳴らない時間が続く。
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'running' && timer) nextStepTime = ctx.currentTime + 0.05;
      if (onState) onState(ctx.state);
    });

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);

    bgmBus = ctx.createGain();
    bgmBus.gain.value = 0;         // 再生開始時にフェードインする

    // 合成音は打点が立ちやすく、そのままだと平均音量に対してピークが尖る。
    // 軽くまとめて、市販曲に近い密度感にする。
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.18;

    // コンプ後に固定の減衰を入れて、元音源と同じくらいの音量に合わせる
    // （圧縮量を変えずにレベルだけ下げたいので、ここで掛ける）
    const trim = ctx.createGain();
    trim.gain.value = BGM_TRIM;
    bgmBus.connect(comp).connect(trim).connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);

    // 効果音で使い回すホワイトノイズ
    const len = Math.floor(ctx.sampleRate * 3);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    return ctx;
  }

  /**
   * 出力を起こす。自動再生制限の解除と、iOS の中断からの復帰を兼ねる。
   * 画面操作の中から呼ぶこと（そうでないと iOS では resume が失敗しうる）。
   */
  function init() {
    const c = ac();
    if (c.state !== 'running') c.resume?.().catch(() => {});
    return c.state;
  }

  /**
   * iPhone の消音スイッチ対策。
   * 既定（ambient）だとスイッチが消音側のとき WebAudio は一切鳴らない。
   * BGM を流している間だけ playback にして、止めたら戻す。
   * iOS 16.4 未満や他ブラウザにはこの API がないので、あれば使う程度に扱う。
   */
  function setSession(type) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = type;
    } catch (_) { /* 未対応 */ }
  }

  /** 出力の状態（'running' なら鳴っている）。未生成なら null */
  function state() {
    return ctx ? ctx.state : null;
  }

  /** 状態が変わったときに呼ばれる関数を登録する */
  function setStateListener(fn) {
    onState = fn;
  }

  function noise(t, dur) {
    const src = ac().createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.start(t, Math.random() * 2, dur);
    return src;
  }

  /** 予約時刻より前に素通ししないよう、ゲインは無音から始める */
  function silentGain() {
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    return g;
  }

  /** 立ち上がり→減衰の包絡線をまとめて書くための小道具 */
  function envelope(gain, t, attack, peak, decay, sustain) {
    gain.value = 0.0001;                 // t より前を無音にしておく
    gain.setValueAtTime(0.0001, t);
    gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.exponentialRampToValueAtTime(Math.max(peak * (sustain ?? 0.001), 0.0001), t + attack + decay);
  }

  // ------------------------------------------------------------ 効果音
  /** 投下音。低めの短いノック */
  function drop() {
    if (muted) return;
    const c = ac(), t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.09);
    envelope(g.gain, t, 0.005, 0.16, 0.1);
    o.connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + 0.14);
  }

  /** 合体音。段階が上がるほど高くなる 2 音 */
  function merge(stage) {
    if (muted) return;
    const c = ac(), t = c.currentTime;
    const base = 320 * Math.pow(1.09, stage);
    [[base, 0, 0.16], [base * 1.5, 0.055, 0.14]].forEach(([f, delay, dur]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + delay);
      envelope(g.gain, t + delay, 0.008, 0.18, dur);
      o.connect(g).connect(sfxBus);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.05);
    });
  }

  /** 最大段階どうしを消したときのファンファーレ */
  function finish() {
    if (muted) return;
    const c = ac(), t = c.currentTime;
    [0, 4, 7, 12].forEach((semi, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(midi(72 + semi), t + i * 0.11);
      envelope(g.gain, t + i * 0.11, 0.01, 0.1, 0.28);
      o.connect(g).connect(sfxBus);
      o.start(t + i * 0.11);
      o.stop(t + i * 0.11 + 0.34);
    });
  }

  /**
   * ファンファーレ用の声。のこぎり波と矩形波を重ね、
   * ローパスを開きながら鳴らして金管っぽい立ち上がりにする。
   */
  function brass(t, note, dur, level, bright) {
    const c = ctx;
    const out = silentGain();
    envelope(out.gain, t, 0.012, level, dur, 0.55);
    out.gain.setValueAtTime(out.gain.value, t + dur);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.18);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(midi(note) * 1.6, t);
    lp.frequency.exponentialRampToValueAtTime(midi(note) * (bright || 5), t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(midi(note) * 2.2, t + dur + 0.18);
    lp.Q.value = 0.8;
    lp.connect(out).connect(sfxBus);

    [['sawtooth', 0, 0.6], ['square', 6, 0.3]].forEach(([type, detune, mix]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(midi(note), t);
      o.detune.value = detune;
      g.gain.value = mix;
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.25);
    });
  }

  /** 和音を厚みのある持続音で鳴らす */
  function chord(t, notes, dur, level) {
    notes.forEach((n, i) => brass(t + i * 0.012, n, dur, level, 4.5));
  }

  /** シンバル代わりの短いきらめき */
  function shimmer(t, dur, level) {
    const c = ctx;
    const n = noise(t, dur), hp = c.createBiquadFilter(), g = silentGain();
    hp.type = 'highpass';
    hp.frequency.value = 5500;
    envelope(g.gain, t, 0.006, level, dur);
    n.connect(hp).connect(g).connect(sfxBus);
    n.stop(t + dur + 0.05);
  }

  /**
   * 開始ファンファーレ。主和音を駆け上がって最後に伸ばす、いちばん素直な形。
   */
  function fanfareStart() {
    const c = ac();
    if (muted) return;
    const t = c.currentTime;

    // G4 → C5 → E5 → G5 と駆け上がる
    [[67, 0], [72, 0.10], [76, 0.20], [79, 0.30]].forEach(([note, at]) => {
      brass(t + at, note, 0.1, 0.17, 5.5);
    });
    // 到達点の和音を伸ばす
    chord(t + 0.44, [72, 76, 79, 84], 0.85, 0.13);
    shimmer(t + 0.44, 0.5, 0.1);
  }

  /**
   * 終了ファンファーレ。主和音を下りてきて低めの和音で締める。
   */
  function fanfareEnd() {
    const c = ac();
    if (muted) return;
    const t = c.currentTime;

    // C5 → G4 → E4 と下りる
    [[72, 0], [67, 0.22], [64, 0.44]].forEach(([note, at]) => {
      brass(t + at, note, 0.2, 0.2, 4.5);
    });
    // 低めの主和音で終止
    chord(t + 0.72, [48, 55, 60, 64], 1.05, 0.17);
    shimmer(t + 0.72, 0.35, 0.06);
  }

  // ------------------------------------------------------------ BGM
  function kick(t) {
    const c = ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    envelope(g.gain, t, 0.004, 1.0 * MIX, 0.22);
    o.connect(g).connect(bgmBus);
    o.start(t);
    o.stop(t + 0.3);
  }

  function hat(t, accent, open) {
    const c = ctx;
    const n = noise(t, open ? 0.3 : 0.06), hp = c.createBiquadFilter(), g = silentGain();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    envelope(g.gain, t, 0.002, (accent ? 1.6 : 0.9) * MIX, open ? 0.26 : 0.06);
    n.connect(hp).connect(g).connect(bgmBus);
    n.stop(t + (open ? 0.32 : 0.08));
  }

  function clap(t) {
    const c = ctx;
    const n = noise(t, 0.18), bp = c.createBiquadFilter(), g = silentGain();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;
    envelope(g.gain, t, 0.004, 0.5 * MIX, 0.16);
    n.connect(bp).connect(g).connect(bgmBus);
    n.stop(t + 0.22);
  }

  function bass(t, note, dur) {
    const c = ctx;
    const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.setValueAtTime(midi(note), t);
    lp.type = 'lowpass';
    lp.frequency.value = 680;
    envelope(g.gain, t, 0.012, 1.3 * MIX, dur, 0.45);
    g.gain.setValueAtTime(g.gain.value, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
    o.connect(lp).connect(g).connect(bgmBus);
    o.start(t);
    o.stop(t + dur + 0.1);

    // 基音だけのサインを重ねて низ を厚くする
    const sub = c.createOscillator(), sg = silentGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(midi(note), t);
    envelope(sg.gain, t, 0.015, 0.8 * MIX, dur, 0.5);
    sg.gain.setValueAtTime(sg.gain.value, t + dur);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
    sub.connect(sg).connect(bgmBus);
    sub.start(t);
    sub.stop(t + dur + 0.1);
  }

  function pad(t, notes, dur) {
    const c = ctx;
    notes.forEach((n) => {
      const o = c.createOscillator(), g = silentGain(), lp = c.createBiquadFilter();
      o.type = 'triangle';
      o.frequency.setValueAtTime(midi(n), t);
      o.detune.value = (Math.random() - 0.5) * 8;
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const level = 1.7 * MIX;      // 中域の芯はここで作る
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.25);
      g.gain.setValueAtTime(level, t + dur - 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp).connect(g).connect(bgmBus);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  }

  function pluck(t, note) {
    const c = ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(midi(note), t);
    envelope(g.gain, t, 0.006, 1.2 * MIX, 0.32);
    o.connect(g).connect(bgmBus);
    o.start(t);
    o.stop(t + 0.4);
  }

  /** 1 ステップ（8 分音符）ぶんを予約する */
  function scheduleStep(i, t) {
    const bar = Math.floor(i / STEPS_PER_BAR);
    const inBar = i % STEPS_PER_BAR;
    const part = PROGRESSION[bar % PROGRESSION.length];

    if (inBar === 0) {
      pad(t, part.chord, STEP * STEPS_PER_BAR);
      bass(t, part.root, STEP * 1.5);
    }
    if (inBar === 3) bass(t, part.root + 12, STEP * 0.8);
    if (inBar === 4) bass(t, part.root, STEP * 1.5);
    if (inBar === 6) bass(t, part.root + 7, STEP * 0.8);

    if (inBar === 0 || inBar === 4) kick(t);
    if (inBar === 2 || inBar === 6) clap(t);
    hat(t, inBar % 2 === 0, inBar === 7);

    // 上物は後半 8 小節だけ、少し表情をつける
    if (bar >= 8) {
      const pick = MELODY_PATTERN[inBar];
      if (pick) pluck(t, part.color[pick % part.color.length]);
    }
  }

  function tick() {
    const c = ctx;
    // タブが重いなどで setInterval が遅れると予約時刻が過去になり、
    // そのぶんの音が鳴らずに穴が開く。遅れたぶんは飛ばして現在に追いつかせる。
    if (nextStepTime < c.currentTime) {
      const behind = Math.ceil((c.currentTime - nextStepTime) / STEP);
      stepIndex = (stepIndex + behind) % TOTAL_STEPS;
      nextStepTime += behind * STEP;
    }
    while (nextStepTime < c.currentTime + SCHEDULE_AHEAD) {
      scheduleStep(stepIndex, nextStepTime);
      nextStepTime += STEP;
      stepIndex = (stepIndex + 1) % TOTAL_STEPS;
    }
  }

  function startBgm(volume) {
    const c = ac();
    stopBgm();
    init();
    setSession('playback');
    stepIndex = 0;
    nextStepTime = c.currentTime + 0.1;
    bgmBus.gain.cancelScheduledValues(c.currentTime);
    bgmBus.gain.setValueAtTime(0.0001, c.currentTime);
    bgmBus.gain.exponentialRampToValueAtTime(volume, c.currentTime + 0.6);
    tick();
    timer = setInterval(tick, LOOKAHEAD_MS);
  }

  function stopBgm() {
    if (timer) { clearInterval(timer); timer = null; }
    setSession('auto');
    if (bgmBus) {
      const t = ctx.currentTime;
      bgmBus.gain.cancelScheduledValues(t);
      bgmBus.gain.setValueAtTime(Math.max(bgmBus.gain.value, 0.0001), t);
      bgmBus.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    }
  }

  function pauseBgm() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function resumeBgm(volume) {
    if (timer || !ctx) return;
    // 裏に回っている間に止められているので、まず起こす。
    // 起こし終える前に予約しても意味がないぶんは statechange 側で取り直す。
    init();
    setSession('playback');
    nextStepTime = ctx.currentTime + 0.05;
    bgmBus.gain.setValueAtTime(volume, ctx.currentTime);
    tick();
    timer = setInterval(tick, LOOKAHEAD_MS);
  }

  // ------------------------------------------------------------ 共通
  function setMuted(on) {
    muted = on;
    if (master) master.gain.value = on ? 0 : 1;
  }

  /** スケジューラの状態（デバッグ用） */
  function debug() {
    return {
      running: !!timer,
      stepIndex,
      nextStepTime: ctx ? +nextStepTime.toFixed(2) : null,
      ctxTime: ctx ? +ctx.currentTime.toFixed(2) : null,
      behind: ctx ? +(ctx.currentTime - nextStepTime).toFixed(2) : null,
      busGain: bgmBus ? +bgmBus.gain.value.toFixed(4) : null,
      state: ctx ? ctx.state : null,
    };
  }

  /** 出力を測るための分岐点（デバッグ用） */
  function tap() {
    const c = ac();
    const analyser = c.createAnalyser();
    analyser.fftSize = 4096;
    master.connect(analyser);
    return analyser;
  }

  return {
    init, setMuted, tap, debug, state, setStateListener,
    drop, merge, finish, fanfareStart, fanfareEnd,
    startBgm, stopBgm, pauseBgm, resumeBgm,
  };
})();
