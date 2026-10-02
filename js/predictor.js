/*!
 * RPS-Duel · 自适应预测核心
 * 多标准「专家」加权投票：每个标准独立统计人类出招习惯，按应验率动态加权。
 */
(function (global) {
  'use strict';

  const MOVES = ['R', 'P', 'S'];
  const NAMES = { R: '石头', P: '布', S: '剪刀' };
  const EMOJI = { R: '✊', P: '✋', S: '✌️' };
  const COUNTER = { R: 'P', P: 'S', S: 'R' }; // COUNTER[x] = 能击败 x 的招
  const VICTIM = { R: 'S', P: 'R', S: 'P' };  // VICTIM[x] = 被 x 击败的招

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

  const sum = (c) => c.R + c.P + c.S;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 样本收缩：把应验率 p 按样本量 n 向随机基准 1/3 收缩，z 为收缩强度（z=0 时原样返回）。
   * 用「向基准收缩」而不是「置信下界」，好处是高于基准的应验率始终保留正权重，
   * 不会因为收缩过强而让所有标准一起归零（AI 失去全部依据）。
   */
  function shrink(p, n, z) {
    if (!n || !z) return p;
    return 1 / 3 + (p - 1 / 3) * (n / (n + z));
  }

  /** 拉普拉斯平滑后的概率分布 */
  function laplace(c, alpha) {
    const t = sum(c);
    const out = {};
    for (const m of MOVES) out[m] = (c[m] + alpha) / (t + 3 * alpha);
    return out;
  }

  /** 均匀分布 */
  function uniform() {
    return { R: 1 / 3, P: 1 / 3, S: 1 / 3 };
  }

  /* ------------------------------ 无偏随机工具 ------------------------------ */

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

  /** 取概率最大项，随机打破平局（避免固定偏向） */
  function argmaxProbs(p) {
    let best = MOVES[0];
    let bv = -Infinity;
    const order = shuffled(MOVES);
    for (const m of order) {
      if (p[m] > bv + 1e-9) {
        bv = p[m];
        best = m;
      }
    }
    return best;
  }

  /** 对预测分布选期望收益最高的出招（赢概率 − 输概率最大）；概率相等时随机打破 */
  function bestMove(p) {
    const order = shuffled(MOVES);
    let best = order[0];
    let bv = -Infinity;
    for (const c of order) {
      const score = p[VICTIM[c]] - p[COUNTER[c]];
      if (score > bv + 1e-9) {
        bv = score;
        best = c;
      }
    }
    return best;
  }

  /**
   * 单个「标准」（专家）。
   * source = 'freq' 整体频率 | 'self' 人类自身前 N 招 | 'opp' 对电脑前 N 招
   */
  class Expert {
    constructor(source, order, mode) {
      this.source = source;
      this.order = order;
      this.mode = mode || 'moves';   // 'moves' 出招序列 | 'result' 胜负关系序列
      this.baseline = source === 'random'; // 随机基线：不学习，命中率恒为 1/3
      this.buckets = new Map(); // key -> { R, P, S }
      this.hits = 0;            // 该标准预测命中的次数
      this.tries = 0;           // 该标准参与评估的次数
    }

    get name() {
      if (this.source === 'freq') return '整体频率';
      if (this.source === 'random') return '随机基线';
      const who = this.source === 'self' ? '人类' : '电脑';
      return this.mode === 'result'
        ? `${who}胜负 ${this.order}`
        : `${who}前 ${this.order} 招`;
    }

    get desc() {
      if (this.source === 'freq') return '你历史上三招的整体偏好';
      if (this.source === 'random') return '不看任何信息、每次均匀随机；命中率恒为 1/3，作为衡量其它标准的基准';
      if (this.source === 'self') {
        return this.mode === 'result'
          ? `你最近 ${this.order} 招之间的胜负关系（每招相对自己上一招）`
          : `你自己最近连续 ${this.order} 招的出招序列`;
      }
      return this.mode === 'result'
        ? `你最近 ${this.order} 招相对电脑相应招的胜负关系`
        : `电脑最近连续 ${this.order} 招之后你的应对`;
    }

    /** 当前局面下的匹配键；历史长度不足返回 null */
    keyFor(history) {
      if (this.source === 'freq' || this.source === 'random') return 'ALL';

      if (this.mode === 'result') {
        // 胜负关系序列
        if (this.source === 'self') {
          if (history.length < this.order + 1) return null;
          const seq = [];
          for (let i = history.length - this.order; i < history.length; i++) {
            seq.push(relation(history[i].human, history[i - 1].human));
          }
          return seq.join('>');
        }
        if (history.length < this.order) return null;
        return history
          .slice(-this.order)
          .map((h) => relation(h.human, h.cpu))
          .join('>');
      }

      // 出招序列
      if (history.length < this.order) return null;
      return history
        .slice(-this.order)
        .map((h) => (this.source === 'self' ? h.human : h.cpu))
        .join('>');
    }

    bucket(key) {
      let b = this.buckets.get(key);
      if (!b) {
        b = { R: 0, P: 0, S: 0 };
        this.buckets.set(key, b);
      }
      return b;
    }

    peek(key) {
      return this.buckets.get(key) || null;
    }

    get accuracy() {
      if (this.baseline) return 1 / 3;      // 随机基线：命中率恒为 1/3
      return this.tries ? this.hits / this.tries : 0;
    }

    reset() {
      this.buckets = new Map();
      this.hits = 0;
      this.tries = 0;
    }
  }

  class Predictor {
    constructor(N, options) {
      this.N = clamp(N | 0 || 3, 1, 8);
      this.options = Object.assign(
        { alpha: 1, exploreScale: 1, explore: true, confidence: 1, halfLife: 16 },
        options || {}
      );
      this.experts = [];
      this.build();
    }

    build() {
      this.experts = [new Expert('freq', 0)];
      for (let k = 1; k <= this.N; k++) this.experts.push(new Expert('self', k, 'moves'));
      for (let k = 1; k <= this.N; k++) this.experts.push(new Expert('opp', k, 'moves'));
      for (let k = 1; k <= this.N; k++) this.experts.push(new Expert('self', k, 'result'));
      for (let k = 1; k <= this.N; k++) this.experts.push(new Expert('opp', k, 'result'));
      this.experts.push(new Expert('random', 0));
    }

    /** 用历史回放重建学习（改变 N 时保留已有对局的学习成果） */
    replay(history) {
      for (const e of this.experts) e.reset();
      for (let i = 0; i < history.length; i++) {
        this.learn(history.slice(0, i), history[i].human);
      }
    }

    /**
     * 学习一步：history 为「本次出招前」的历史，humanMove 为人类本次实际出招。
     * 先以旧计数评估各标准预测是否应验，再累加新计数。
     */
    learn(history, humanMove) {
      // 时间衰减：每局旧计数乘一次 decay，半衰期 hl 局后权重减半（0 = 不遗忘）
      const hl = Number(this.options.halfLife) || 0;
      const decay = hl > 0 ? Math.pow(0.5, 1 / hl) : 1;
      for (const e of this.experts) {
        if (e.baseline) continue;   // 随机基线不参与学习
        const key = e.keyFor(history);
        if (key === null) continue;
        const b = e.bucket(key);
        const known = sum(b);
        if (known >= 1) {
          const pred = argmaxProbs(laplace(b, this.options.alpha));
          e.tries = e.tries * decay + 1;
          e.hits = e.hits * decay + (pred === humanMove ? 1 : 0);
        }
        if (decay < 1) {
          b.R *= decay;
          b.P *= decay;
          b.S *= decay;
        }
        b[humanMove]++;
      }
    }

    /**
     * 决策：返回电脑出招与完整依据（供面板展示）。
     */
    /**
     * 决策：返回电脑出招与完整依据（供面板展示）。
     * confidenceOverride 可临时覆盖样本收缩强度（自动调参用它评估各档位的实际表现）。
     */
    decide(history, confidenceOverride) {
      const breakdown = [];
      const acc = { R: 0, P: 0, S: 0 };
      let weightSum = 0;
      const zOpt = confidenceOverride == null
        ? Number(this.options.confidence) || 0
        : Number(confidenceOverride) || 0;

      for (const e of this.experts) {
        if (e.baseline) {
          // 随机基线：均匀分布，不参与合成（无预测能力，仅作基准展示）
          const probs = uniform();
          const weight = 0;
          for (const m of MOVES) acc[m] += weight * probs[m];
          weightSum += weight;
          breakdown.push({
            expert: e,
            matched: true,
            baseline: true,
            key: 'ALL',
            counts: null,
            probs,
            weight,
            accuracy: 1 / 3,
            tries: 0,
            prediction: null,
          });
          continue;
        }
        const key = e.keyFor(history);
        if (key === null) {
          breakdown.push({ expert: e, matched: false, key: null });
          continue;
        }
        const b = e.peek(key);
        const n = b ? sum(b) : 0;
        if (!b || n === 0) {
          breakdown.push({ expert: e, matched: false, key });
          continue;
        }

        const probs = laplace(b, this.options.alpha);
        const conf = n / (n + 1);                 // 样本越多越自信（早期折扣较宽，让应验率尽早生效）
        // 样本收缩：应验率向 1/3 基准收缩（zOpt 为强度，0 = 直接用应验率）
        const accEst = zOpt > 0 ? shrink(e.accuracy, e.tries, zOpt) : e.accuracy;
        const weight = Math.max(0, accEst - 1 / 3) * conf;
        for (const m of MOVES) acc[m] += weight * probs[m];
        weightSum += weight;

        breakdown.push({
          expert: e,
          matched: true,
          key,
          counts: { R: b.R, P: b.P, S: b.S },
          probs,
          weight,
          accuracy: e.accuracy,
          tries: e.tries,
          prediction: argmaxProbs(probs),
          // 参照招：用于把具体招式计数换算成「相对关系」展示
          refMove: e.source === 'self'
            ? history[history.length - 1].human
            : e.source === 'opp'
              ? history[history.length - 1].cpu
              : null,
        });
      }

      let meta = uniform();
      if (weightSum > 0) {
        meta = {};
        for (const m of MOVES) meta[m] = acc[m] / weightSum;
      }

      // 三招各自的期望收益（赢概率 − 输概率），与 bestMove 的评分一致
      const scores = {};
      for (const m of MOVES) scores[m] = meta[VICTIM[m]] - meta[COUNTER[m]];

      // 归一化权重占比（供面板展示，各参与标准合计为 1）
      if (weightSum > 0) {
        for (const it of breakdown) {
          if (it.matched) it.share = it.weight / weightSum;
        }
      }

      // 探索：预测越不确定、历史应验越差，扰动越大（避免被人类反向利用）
      let hits = 0;
      let tries = 0;
      for (const e of this.experts) {
        hits += e.hits;
        tries += e.tries;
      }
      // 应验率同样按样本量收缩：tries=1 时命中即 100% 只是运气，
      // 不能让它把探索压到地板（否则前期 AI 拿一个样本就"自信"出招，极易被人类预判）
      const globalAcc = shrink(tries ? hits / tries : 1 / 3, tries, 4);
      let epsilon = clamp(0.12 - globalAcc * 0.18, 0.02, 0.12);
      const maxP = Math.max(meta.R, meta.P, meta.S);
      if (maxP < 0.4) epsilon = clamp(epsilon + 0.05, 0.02, 0.18);
      // 前期随机度：开局这几局证据不足，AI 就该更接近纯随机。
      // 少量样本给出的偏斜（"AI 总是出某个招"）太容易被人类摸清，
      // 随机度必须能压住它；对局数越多随机度越低，11 局左右回落到常规水平。
      epsilon = Math.max(epsilon, clamp(1 - history.length * 0.09, 0.02, 1));
      epsilon = this.options.explore
        ? clamp(epsilon * this.options.exploreScale, 0, 1)
        : 0;

      const final = {};
      for (const m of MOVES) final[m] = (1 - epsilon) * meta[m] + epsilon / 3;

      // 决策：在综合分布上取期望收益最大的招（赢概率 − 输概率）
      const bestCpu = bestMove(meta);          // 不含探索的最优招
      let cpuMove = bestCpu;
      let explore = false;
      if (epsilon > 0 && randFloat() < epsilon) {
        cpuMove = MOVES[randInt(MOVES.length)];
        explore = true;
      }
      const target = VICTIM[bestCpu];         // 电脑按预测最优会击败的招（不含探索，用作命中率的尺子）

      // 各参与标准的加权平均应验率（供自动调参与面板展示）
      let accSum = 0;
      let wSum = 0;
      for (const it of breakdown) {
        if (it.matched && !it.baseline) {
          accSum += it.weight * it.accuracy;
          wSum += it.weight;
        }
      }

      return {
        cpuMove,
        bestCpu,
        target,
        metaProbs: meta,
        probs: final,
        breakdown,
        epsilon,
        explore,
        avgAcc: wSum > 0 ? accSum / wSum : 1 / 3,
        weightSum,                              // 归一化前总权重（0 = 没有任何可信标准）
        scores,                                 // 三招各自的期望收益（赢−输）
      };
    }
  }

  global.RPS = { MOVES, NAMES, EMOJI, COUNTER, VICTIM, relation, Predictor, Expert, judge, randInt, randFloat };
})(window);
