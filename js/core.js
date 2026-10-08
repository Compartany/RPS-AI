/*!
 * RPS-AI · 基础库
 *
 * 招式常量、胜负判定、无偏随机与统计小工具 —— 供预测核心与应用层共用。
 */
(function (global) {
  'use strict';

  /* ------------------------------ 招式 ------------------------------ */

  /* 顺序即界面顺序（石头 → 剪刀 → 布）：凡是遍历 MOVES 的地方都按这个次序展示 */
  const MOVES = ['R', 'S', 'P'];
  const NAMES = { R: '石头', P: '布', S: '剪刀' };
  const EMOJI = { R: '✊', P: '✋', S: '✌️' };   // 界面与日志都用 emoji 字符，字形由 assets/noto-subset.css 的字体决定
  const COUNTER = { R: 'P', P: 'S', S: 'R' };  // COUNTER[x] = 能击败 x 的招
  const VICTIM = { R: 'S', P: 'R', S: 'P' };   // VICTIM[x] = 被 x 击败的招

  /** 人类 h 对电脑 c 的结果：'human' | 'cpu' | 'draw' */
  function judge(h, c) {
    if (h === c) return 'draw';
    return COUNTER[c] === h ? 'human' : 'cpu';
  }

  /** 人类招 h 相对参照招 r 的关系：'win'(克制) | 'draw'(相同/平) | 'lose'(被克制/输) */
  function relation(h, r) {
    if (h === r) return 'draw';
    return COUNTER[r] === h ? 'win' : 'lose';
  }

  /* ------------------------------ 数学 ------------------------------ */

  const sum = (counts) => counts.R + counts.P + counts.S;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 四舍五入到两位小数（与界面展示精度一致：界面上数字相同的两招就该同等对待） */
  const round2 = (v) => Math.round(v * 100) / 100;

  /** 均匀分布 */
  const uniform = () => ({ R: 1 / 3, P: 1 / 3, S: 1 / 3 });

  /**
   * 样本收缩：把应验率 p 按样本量 n 向随机基准 1/3 收缩，z 为收缩强度（z = 0 时原样返回）。
   * 用「向基准收缩」而不是「置信下界」，好处是高于基准的应验率始终保留正权重，
   * 不会因为收缩过强而让所有标准一起归零（AI 失去全部依据）。
   */
  function shrink(p, n, z) {
    if (!n || !z) return p;
    return 1 / 3 + (p - 1 / 3) * (n / (n + z));
  }

  /** 拉普拉斯平滑后的概率分布 */
  function laplace(counts, alpha) {
    const total = sum(counts);
    const out = {};
    for (const m of MOVES) out[m] = (counts[m] + alpha) / (total + 3 * alpha);
    return out;
  }

  /** 时间加权平均：arr 由旧到新，hl 为半衰期（局）；hl = 0 时等权 */
  function weightedMean(arr, hl) {
    const n = arr.length;
    if (!n) return 0;
    if (!hl) return arr.reduce((a, b) => a + b, 0) / n;
    let sw = 0;
    let sv = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.pow(0.5, (n - 1 - i) / hl);
      sw += w;
      sv += arr[i] * w;
    }
    return sw ? sv / sw : 0;
  }

  /* ------------------------------ 无偏随机 ------------------------------ */

  // crypto.getRandomValues 走操作系统熵源，质量远高于 Math.random（后者是实现的 PRNG）。
  const HAS_CRYPTO = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';

  /** 均匀随机浮点 [0,1) */
  function randFloat() {
    if (!HAS_CRYPTO) return Math.random();
    const u = new Uint32Array(1);
    crypto.getRandomValues(u);
    return u[0] / 4294967296;
  }

  /**
   * 均匀随机整数 [0, n)（n ≤ 256）。
   * 用拒绝采样：源的字节范围 0~255 未必能被 n 整除（256 % 3 = 1），
   * 直接 `% n` 会让 0、1 比 2 多出 1/256 的概率；丢掉尾部零头则完全无偏。
   */
  function randInt(n) {
    if (!HAS_CRYPTO || n > 256) return Math.floor(randFloat() * n);
    const limit = Math.floor(256 / n) * n;
    const buf = new Uint8Array(1);
    let v;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % n;
  }

  /** Fisher–Yates 洗牌（`sort(() => Math.random() - 0.5)` 的分布并不均匀） */
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /* ------------------------------ 概率决策 ------------------------------ */

  /** 取概率最大项，随机打破平局（避免固定偏向） */
  function argmaxProbs(p) {
    let best = MOVES[0];
    let bv = -Infinity;
    for (const m of shuffled(MOVES)) {
      if (p[m] > bv + 1e-9) {
        bv = p[m];
        best = m;
      }
    }
    return best;
  }

  /**
   * 期望收益并列最高的出招集合（赢概率 − 输概率最大）。
   * 并列判定用的就是界面展示精度（两位小数）：界面上数字一模一样的两招就该同等对待，
   * 否则会出现「两颗都写着 +0.30，却只认其中一颗是推荐」的别扭。
   * 返回数组 —— 长度为 1 时即唯一最优，调用方自行决定是随机挑一个还是并列展示。
   */
  function bestMoves(scores) {
    const top = round2(Math.max(...MOVES.map((m) => scores[m])));
    return MOVES.filter((m) => round2(scores[m]) === top);
  }

  /**
   * 按概率分布随机取一招。
   * 预测没有显著优于随机基准时，与其用 argmax 押一个「靠噪声排出来的最优招」（确定性函数，
   * 排序一旦固定就会长期出同一招，极易被反制），不如按分布取样——仍是同一份预测，
   * 但出招的边际分布等于预测分布，对手无法靠观察固定规律来针对。
   */
  function sampleProbs(p) {
    const order = shuffled(MOVES);
    let r = randFloat();
    for (const m of order) {
      r -= p[m];
      if (r < 0) return m;
    }
    return order[order.length - 1];
  }

  global.RPS = {
    MOVES, NAMES, EMOJI, COUNTER, VICTIM,
    judge, relation,
    sum, clamp, round2, uniform, shrink, laplace, weightedMean,
    randFloat, randInt, shuffled, argmaxProbs, bestMoves, sampleProbs,
  };
})(window);
