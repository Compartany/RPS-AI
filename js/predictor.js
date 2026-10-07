/*!
 * RPS-AI · 自适应预测核心
 *
 * 多标准「专家」加权投票：每个标准独立统计「被预测者」的出招习惯，按应验率动态加权。
 */
(function (global) {
  'use strict';

  const {
    MOVES, COUNTER, VICTIM,
    relation, sum, clamp, shrink, laplace, uniform,
    randInt, randFloat, argmaxProbs, bestMoves, sampleProbs,
  } = global.RPS;

  /* ------------------------------ 决策参数 ------------------------------ */

  // ε（本局纯随机出招概率）的三项来源
  const EPS = {
    base: 0.12, slope: 0.18, lo: 0.02, hi: 0.12,   // 自适应扰动 = base − 应验率 × slope，夹在 [lo, hi]
    flatGap: 0.4, flatBonus: 0.05, flatHi: 0.18,   // 最大概率 < flatGap 时再加 flatBonus，上限 flatHi
    earlySlope: 0.09, earlyLo: 0.02,               // 开局随机度 = 1 − 局数 × earlySlope，夹在 [earlyLo, 1]
    accShrink: 4,                                  // 全局应验率的收缩强度
  };

  /**
   * 单个「标准」（专家）。
   * source = 'freq' 整体频率 | 'self' 人类自身前 N 招 | 'opp' 对电脑前 N 招 | 'random' 随机基线
   */
  class Expert {
    constructor(source, order, mode) {
      this.source = source;
      this.order = order;
      this.mode = mode || 'moves';   // 'moves' 出招序列 | 'result' 胜负关系序列
      this.baseline = source === 'random'; // 随机基线：不学习，命中率恒为 1/3
      this.buckets = new Map();      // key -> { R, P, S }
      this.hits = 0;                 // 该标准预测命中的次数
      this.tries = 0;                // 该标准参与评估的次数
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
      if (this.source === 'freq') return '人类历史上三招的整体偏好';
      if (this.source === 'random') return '不看任何信息、每次均匀随机；命中率恒为 1/3，作为衡量其它标准的基准';
      if (this.source === 'self') {
        return this.mode === 'result'
          ? `人类最近 ${this.order} 招之间的胜负关系（每招相对自己上一招）`
          : `人类自己最近连续 ${this.order} 招的出招序列`;
      }
      return this.mode === 'result'
        ? `人类最近 ${this.order} 招相对电脑相应招的胜负关系`
        : `电脑最近连续 ${this.order} 招之后人类的应对`;
    }

    /**
     * 当前局面下的匹配键；历史长度不足返回 null。
     * end 表示「只看前 end 局」（缺省为全部），供回放时免去切数组的开销。
     */
    keyFor(history, end) {
      if (this.source === 'freq' || this.source === 'random') return 'ALL';
      const len = end == null ? history.length : end;

      if (this.mode === 'result') {
        // 胜负关系序列
        if (this.source === 'self') {
          if (len < this.order + 1) return null;
          const seq = [];
          for (let i = len - this.order; i < len; i++) {
            seq.push(relation(history[i].human, history[i - 1].human));
          }
          return seq.join('>');
        }
        if (len < this.order) return null;
        const seq = [];
        for (let i = len - this.order; i < len; i++) {
          seq.push(relation(history[i].human, history[i].cpu));
        }
        return seq.join('>');
      }

      // 出招序列
      if (len < this.order) return null;
      const seq = [];
      for (let i = len - this.order; i < len; i++) {
        seq.push(this.source === 'self' ? history[i].human : history[i].cpu);
      }
      return seq.join('>');
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

  /* ------------------------------ 合成与决策辅助 ------------------------------ */

  /** 把累加权重归一化为概率分布（无任何可信标准时退回均匀） */
  function normalize(acc, weightSum) {
    if (!(weightSum > 0)) return uniform();
    const meta = {};
    for (const m of MOVES) meta[m] = acc[m] / weightSum;
    return meta;
  }

  /** 三招各自的期望收益（赢概率 − 输概率），口径与 bestMoves 及面板展示一致 */
  function expectedScores(meta) {
    const scores = {};
    for (const m of MOVES) scores[m] = meta[VICTIM[m]] - meta[COUNTER[m]];
    return scores;
  }

  /** 权重占比：参与合成的标准合计为 1；无可信标准时随机基线独占 100% */
  function assignShares(breakdown, weightSum) {
    for (const it of breakdown) {
      if (weightSum > 0) {
        if (it.matched) it.share = it.weight / weightSum;
      } else if (it.baseline) {
        it.share = 1;
      }
    }
  }

  /** 各参与标准的加权平均应验率（供自动调参与面板展示） */
  function weightedAccuracy(breakdown) {
    let accSum = 0;
    let wSum = 0;
    for (const it of breakdown) {
      if (it.matched && !it.baseline) {
        accSum += it.weight * it.accuracy;
        wSum += it.weight;
      }
    }
    return wSum > 0 ? accSum / wSum : 1 / 3;
  }

  /** 把 ε 的均匀随机掺进预测分布：final = (1 − ε)·meta + ε/3 */
  function blendUniform(meta, epsilon) {
    const final = {};
    for (const m of MOVES) final[m] = (1 - epsilon) * meta[m] + epsilon / 3;
    return final;
  }

  /**
   * 依据「探索」与「押注」策略挑出实际出招。
   * 两个随机数按固定顺序取用（与旧实现一致，保持行为不变）。
   */
  function pickMove(meta, { weightSum, epsilon, trust, bestCpu }) {
    if (weightSum === 0) {
      // 没有任何可信依据，谈不上「预测最优」，只能随机出招
      return { cpuMove: MOVES[randInt(MOVES.length)], explore: false, sampled: false };
    }
    if (epsilon > 0 && randFloat() < epsilon) {
      return { cpuMove: MOVES[randInt(MOVES.length)], explore: true, sampled: false };
    }
    if (randFloat() >= trust) {
      // 预测还没有显著优于随机：不押注最优招，改按预测分布取样
      return { cpuMove: sampleProbs(meta), explore: false, sampled: true };
    }
    return { cpuMove: bestCpu, explore: false, sampled: false };
  }

  class Predictor {
    constructor(N, options) {
      this.N = clamp(N | 0 || 3, 1, 8);
      this.options = Object.assign(
        { alpha: 1, exploreScale: 0.1, explore: true, confidence: 1, halfLife: 16 },
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

    /** 用历史回放重建学习（改变 N / α / 半衰期时保留已有对局的学习成果） */
    replay(history) {
      for (const e of this.experts) e.reset();
      for (let i = 0; i < history.length; i++) this.learn(history, history[i].human, i);
    }

    /**
     * 学习一步：只看前 end 局（缺省为全部），humanMove 为被预测者本次实际出招。
     * 先以旧计数评估各标准预测是否应验，再累加新计数。
     */
    learn(history, humanMove, end) {
      // 时间衰减：每局旧计数乘一次 decay，半衰期 hl 局后权重减半
      const hl = Number(this.options.halfLife) || 16;
      const decay = Math.pow(0.5, 1 / hl);
      for (const e of this.experts) {
        if (e.baseline) continue;   // 随机基线不参与学习
        const key = e.keyFor(history, end);
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

    /** 汇总各标准的破绽明细与合成权重（decide 的第一阶段） */
    tally(history, zOpt) {
      const breakdown = [];
      const acc = { R: 0, P: 0, S: 0 };
      let weightSum = 0;

      for (const e of this.experts) {
        if (e.baseline) {
          // 随机基线：均匀分布，不参与合成（无预测能力，仅作基准展示）
          breakdown.push({
            expert: e,
            matched: true,
            baseline: true,
            key: 'ALL',
            counts: null,
            probs: uniform(),
            weight: 0,
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
      return { breakdown, acc, weightSum };
    }

    /**
     * ε 的三项来源与最终取值。
     *   · 探索强度档位 —— 保底纯随机概率，受上层显著性检验约束
     *   · 开局随机度 —— 前期证据不足时临时拉高（约 11 局回落）
     *   · 自适应扰动 —— 应验差 / 预测不确定时抬高
     * 三者取最大即本局实际随机概率；「探索扰动」总开关关闭时恒为 0。
     */
    exploreProfile(history, meta, exploreOverride) {
      // 全局应验率同样按样本量收缩：tries = 1 时命中即 100% 只是运气，
      // 不能让它把探索压到地板（否则前期 AI 拿一个样本就「自信」出招，极易被人类预判）
      let hits = 0;
      let tries = 0;
      for (const e of this.experts) {
        hits += e.hits;
        tries += e.tries;
      }
      const globalAcc = shrink(tries ? hits / tries : 1 / 3, tries, EPS.accShrink);

      // 自适应扰动：预测越不确定、历史应验越差，扰动越大（避免被人类反向利用）
      let adaptiveEps = clamp(EPS.base - globalAcc * EPS.slope, EPS.lo, EPS.hi);
      const maxP = Math.max(meta.R, meta.P, meta.S);
      if (maxP < EPS.flatGap) adaptiveEps = clamp(adaptiveEps + EPS.flatBonus, EPS.lo, EPS.flatHi);

      // 前期随机度：开局这几局证据不足，AI 就该更接近纯随机。
      // 少量样本给出的偏斜（「AI 总是出某个招」）太容易被人类摸清，随机度必须能压住它。
      const earlyRand = clamp(1 - history.length * EPS.earlySlope, EPS.earlyLo, 1);

      // 探索强度档位（0~1）；自适应扰动更高时以更高者为准
      const exploreScale = exploreOverride == null
        ? Number(this.options.exploreScale) || 0
        : Number(exploreOverride) || 0;

      const earlyRandom = this.options.explore && earlyRand > Math.max(adaptiveEps, exploreScale);
      const epsilon = this.options.explore
        ? clamp(Math.max(adaptiveEps, earlyRand, exploreScale), 0, 1)
        : 0;

      return { epsilon, adaptiveEps, earlyRand, earlyRandom, exploreScale };
    }

    /**
     * 决策：返回实际出招与完整依据（供面板展示）。
     * confidenceOverride 可临时覆盖样本收缩强度（自动调参用它评估各档位的实际表现）。
     */
    decide(history, confidenceOverride, exploreOverride) {
      const zOpt = confidenceOverride == null
        ? Number(this.options.confidence) || 0
        : Number(confidenceOverride) || 0;

      // 1) 各标准合成 → 预测分布与期望收益
      const { breakdown, acc, weightSum } = this.tally(history, zOpt);
      const meta = normalize(acc, weightSum);
      const scores = expectedScores(meta);
      assignShares(breakdown, weightSum);

      // 2) 掺入探索扰动
      const eps = this.exploreProfile(history, meta, exploreOverride);
      const final = blendUniform(meta, eps.epsilon);

      // 3) 在综合分布上取期望收益最大的招；并列最优时随机挑一个作为「默认候选」
      const bestTies = bestMoves(scores);
      const bestCpu = bestTies[randInt(bestTies.length)];
      // 押注概率：AI 的预测是否已被证明显著优于随机（由主流程做显著性检验后写入）
      const trust = clamp(Number(this.options.predictTrust) || 0, 0, 1);
      const move = pickMove(meta, { weightSum, epsilon: eps.epsilon, trust, bestCpu });
      // 命中率的尺子 = AI 对下一招的预测（只看预测准不准，与电脑实际出什么招、是否探索无关）
      const target = argmaxProbs(meta);

      return {
        cpuMove: move.cpuMove,
        bestCpu,
        bestTies,                               // 期望收益并列最高的招（含 bestCpu，顺序为 MOVES 顺序）
        target,
        metaProbs: meta,
        probs: final,
        breakdown,
        epsilon: eps.epsilon,
        explore: move.explore,
        sampled: move.sampled,                  // 本局是否「预测不显著 → 按分布取样」（未押注最优招）
        trust,                                  // 本局的押注概率（0 = 从不押注，1 = 总是押注）
        earlyRandom: eps.earlyRandom,           // ε 是否由前期随机度主导
        earlyRand: eps.earlyRand,               // 前期随机度数值（不受上限约束）
        adaptiveEps: eps.adaptiveEps,           // 自适应扰动（不受上限约束）
        exploreScale: eps.exploreScale,         // 探索强度档位（受上限约束）
        avgAcc: weightedAccuracy(breakdown),
        weightSum,                              // 归一化前总权重（0 = 没有任何可信标准）
        scores,                                 // 三招各自的期望收益（赢−输）
      };
    }
  }

  global.RPS.Expert = Expert;
  global.RPS.Predictor = Predictor;
})(window);
