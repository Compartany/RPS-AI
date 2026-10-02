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

  /** 人类 h 对电脑 c 的结果：'human' | 'cpu' | 'draw' */
  function judge(h, c) {
    if (h === c) return 'draw';
    return COUNTER[c] === h ? 'human' : 'cpu';
  }

  const sum = (c) => c.R + c.P + c.S;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

  /** 取概率最大项，随机打破平局（避免固定偏向） */
  function argmaxProbs(p) {
    let best = MOVES[0];
    let bv = -Infinity;
    const order = MOVES.slice().sort(() => Math.random() - 0.5);
    for (const m of order) {
      if (p[m] > bv + 1e-9) {
        bv = p[m];
        best = m;
      }
    }
    return best;
  }

  /**
   * 单个「标准」（专家）。
   * source = 'freq' 整体频率 | 'self' 人类自身前 N 招 | 'opp' 对电脑前 N 招
   */
  class Expert {
    constructor(source, order) {
      this.source = source;
      this.order = order;
      this.buckets = new Map(); // key -> { R, P, S }
      this.hits = 0;            // 该标准预测命中的次数
      this.tries = 0;           // 该标准参与评估的次数
    }

    get name() {
      if (this.source === 'freq') return '整体频率';
      if (this.source === 'self') return `我方前 ${this.order} 招`;
      return `对手前 ${this.order} 招`;
    }

    get desc() {
      if (this.source === 'freq') return '你历史上三招的整体偏好';
      if (this.source === 'self') return `你最近连续 ${this.order} 招之后会出什么`;
      return `电脑最近连续 ${this.order} 招之后你会怎么应对`;
    }

    /** 当前局面下的匹配键；历史长度不足返回 null */
    keyFor(history) {
      if (this.source === 'freq') return 'ALL';
      if (history.length < this.order) return null;
      const seq = history.slice(-this.order);
      return seq.map((h) => (this.source === 'self' ? h.human : h.cpu)).join('>');
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
        { alpha: 1, exploreScale: 1, explore: true },
        options || {}
      );
      this.experts = [];
      this.build();
    }

    build() {
      this.experts = [new Expert('freq', 0)];
      for (let k = 1; k <= this.N; k++) {
        this.experts.push(new Expert('self', k));
        this.experts.push(new Expert('opp', k));
      }
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
      for (const e of this.experts) {
        const key = e.keyFor(history);
        if (key === null) continue;
        const b = e.bucket(key);
        const known = sum(b);
        if (known >= 1) {
          const pred = argmaxProbs(laplace(b, this.options.alpha));
          e.tries++;
          if (pred === humanMove) e.hits++;
        }
        b[humanMove]++;
      }
    }

    /**
     * 决策：返回电脑出招与完整依据（供面板展示）。
     */
    decide(history) {
      const breakdown = [];
      const acc = { R: 0, P: 0, S: 0 };
      let weightSum = 0;

      for (const e of this.experts) {
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
        const conf = n / (n + 2);                 // 样本越多越自信
        const weight = (0.08 + e.accuracy) * conf; // 应验率越高权重越大
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
        });
      }

      let meta = uniform();
      if (weightSum > 0) {
        meta = {};
        for (const m of MOVES) meta[m] = acc[m] / weightSum;
      }

      // 探索：预测越不确定、历史应验越差，扰动越大（避免被人类反向利用）
      let hits = 0;
      let tries = 0;
      for (const e of this.experts) {
        hits += e.hits;
        tries += e.tries;
      }
      const globalAcc = tries ? hits / tries : 1 / 3;
      let epsilon = clamp(0.25 - globalAcc * 0.3, 0.05, 0.25);
      const maxP = Math.max(meta.R, meta.P, meta.S);
      if (maxP < 0.4) epsilon = clamp(epsilon + 0.08, 0.05, 0.3);
      epsilon = this.options.explore
        ? clamp(epsilon * this.options.exploreScale, 0, 0.6)
        : 0;

      const final = {};
      for (const m of MOVES) final[m] = (1 - epsilon) * meta[m] + epsilon / 3;

      const target = argmaxProbs(final);       // AI 认为人类最可能出
      const cpuMove = COUNTER[target];         // 电脑用能击败它的招
      const explore = final[target] - meta[target] > 1e-9;

      return {
        cpuMove,
        target,
        metaProbs: meta,
        probs: final,
        breakdown,
        epsilon,
        explore,
      };
    }
  }

  global.RPS = { MOVES, NAMES, EMOJI, COUNTER, Predictor, Expert, judge };
})(window);
