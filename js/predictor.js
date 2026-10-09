/*!
 * RPS-AI · 自适应预测核心
 *
 * 多标准「专家」加权投票：每个标准独立统计「被预测者」的出招习惯，按应验率动态加权。
 */
(function (global) {
  'use strict';

  const {
    MOVES, RELS, COUNTER, VICTIM,
    relation, relMove, sum, clamp, shrink, laplace, uniform,
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

  // 突变检测：某招在长期统计里几乎不出现、最近几局却密集出现时，把预测分布朝「最近这几局」
  // 靠一次。统计型模型对「历史为零的招突然连出」反应最慢 —— 拉普拉斯平滑下它得从零慢慢爬，
  // 记忆半衰期越长爬得越慢（对手前 34 局一次石头没出，之后连出三个，模型给石头的概率仍不足 0.1）。
  // 这一步只是临时修正：强度完全由「最近 window 局」决定，窗口一滑过去就自动复原，不改任何长期计数。
  const SURGE = {
    window: 5,        // 观察最近多少局
    minCount: 3,      // 突变招在窗口里至少出现几次
    rareShare: 0.12,  // 该招长期占比低于此值才算「历史几乎没出过」（也是挡住随机对手误触发的闸门）
    maxLambda: 0.5,   // 向近期窗口混合的最大比例
    minHistory: 12,   // 历史不足这么多局不做（前期本来就有开局随机度兜底）
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
      this.buckets = new Map();      // key -> 出招桶 { R, P, S }；result 模式则为关系桶 { win, lose, draw }
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
        ? `人类最近 ${this.order} 招相对电脑上一招的胜负关系`
        : `电脑最近连续 ${this.order} 招之后人类的应对`;
    }

    /**
     * 当前局面下的匹配键；历史长度不足返回 null。
     * end 表示「只看前 end 局」（缺省为全部），供回放时免去切数组的开销。
     *
     * 局上带 seg（连续段编号）：一条序列只能由同一段里的局拼成 —— 很久没玩时
     * 会另起一段（见 main.js 的断链），当前局的序列不跨过断点去借旧局的招。
     * 段内局数不足 order（胜负关系序列还要多借一局）时，本局就没有该序列。
     * 局上没有 seg（如基准测试直接构造的历史）时一律视为同一段。
     */
    keyFor(history, end) {
      if (this.source === 'freq' || this.source === 'random') return 'ALL';
      const len = end == null ? history.length : end;
      if (len <= 0) return null;
      const seg = history[len - 1].seg;     // 当前段

      if (this.mode === 'result') {
        // 胜负关系序列：self 相对人类自己上一招，opp 相对电脑上一招。
        // 参照的都是「上一局已出过的招」，所以预测出的关系能唯一换算出人类招式。
        if (len < this.order + 1) return null;
        if (history[len - this.order - 1].seg !== seg) return null;
        const self = this.source === 'self';
        const seq = [];
        for (let i = len - this.order; i < len; i++) {
          const prev = history[i - 1];
          seq.push(relation(history[i].human, self ? prev.human : prev.cpu));
        }
        return seq.join('>');
      }

      // 出招序列
      if (len < this.order) return null;
      if (history[len - this.order].seg !== seg) return null;
      const seq = [];
      for (let i = len - this.order; i < len; i++) {
        seq.push(this.source === 'self' ? history[i].human : history[i].cpu);
      }
      return seq.join('>');
    }

    /**
     * 关系桶的参照招：被预测的第 i 局，其胜负关系是相对「谁上一局出的什么」。
     * self → 人类自己上一招；opp → 电脑上一招。预测下一局时 i = history.length，
     * 二者都是已经出过的招，因此关系能唯一换算出人类下一招。
     */
    refFor(history, i) {
      const prev = history[i - 1];
      return this.source === 'self' ? prev.human : prev.cpu;
    }

    bucket(key) {
      let b = this.buckets.get(key);
      if (!b) {
        b = this.mode === 'result'
          ? { win: 0, lose: 0, draw: 0 }
          : { R: 0, P: 0, S: 0 };
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

  /** 桶内计数合计：出招桶数三招，关系桶数三种关系 */
  const bucketSum = (b, mode) =>
    mode === 'result' ? b.win + b.lose + b.draw : sum(b);

  /** 关系计数 → 关系概率（拉普拉斯平滑） */
  function laplaceRel(counts, alpha) {
    const total = counts.win + counts.lose + counts.draw;
    const out = {};
    for (const r of RELS) out[r] = (counts[r] + alpha) / (total + 3 * alpha);
    return out;
  }

  /**
   * 关系计数 → 人类出招概率分布。
   * 参照招已知时「平 = 照抄参照招、胜 = 克制它、负 = 被它克制」与招式一一对应，
   * 所以关系分布能唯一摊回三招上，再进入原来的加权合成流程。
   */
  function expandRel(counts, alpha, refMove) {
    const rel = laplaceRel(counts, alpha);
    const out = {};
    for (const m of MOVES) out[m] = 0;
    for (const r of RELS) out[relMove(r, refMove)] += rel[r];
    return out;
  }

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
   * 依据「探索」「弃用预测」与「押注」策略挑出实际出招。
   *
   * 先定「建议招」（三选一）：预测被证明显著劣于随机 → 弃用预测、均匀随机；未获押注 →
   * 按预测分布取样；否则押注期望收益最高的一招。再看本局是否触发探索扰动：
   * 触发则 AI 亲自出招时改出均匀随机（建议招不受影响 —— 不下场时不必为「不被看穿」牺牲建议）。
   */
  function pickMove(meta, { weightSum, epsilon, trust, drop, bestCpu }) {
    if (weightSum === 0) {
      // 没有任何可信依据，谈不上「预测最优」，只能随机出招
      const m = MOVES[randInt(MOVES.length)];
      return { cpuMove: m, suggest: m, explore: false, sampled: false, dropped: false };
    }
    let suggest;
    let sampled = false;
    let dropped = false;
    if (drop > 0 && randFloat() < drop) {
      // 预测的偏向与对手实际出招错配，照它取样仍会把这份偏向搬进出招：退回均匀随机
      suggest = MOVES[randInt(MOVES.length)];
      dropped = true;
    } else if (randFloat() >= trust) {
      // 预测还没有显著优于随机：不押注最优招，改按预测分布取样
      suggest = sampleProbs(meta);
      sampled = true;
    } else {
      suggest = bestCpu;
    }
    const explore = epsilon > 0 && randFloat() < epsilon;
    return {
      cpuMove: explore ? MOVES[randInt(MOVES.length)] : suggest,
      suggest,                     // 建议招：辅助模式给玩家看的「我方出什么」
      explore,
      sampled,
      dropped,
    };
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
      const n = end == null ? history.length : end;   // 已见局数（本局为第 n 局）
      for (const e of this.experts) {
        if (e.baseline) continue;   // 随机基线不参与学习
        const key = e.keyFor(history, end);
        if (key === null) continue;
        const b = e.bucket(key);
        const isRel = e.mode === 'result';
        // 本局是第 n 局：键用「前 n 局」拼出，被预测的正是这一局，参照招即第 n-1 局出的招
        const ref = isRel ? e.refFor(history, n) : null;
        if (bucketSum(b, e.mode) >= 1) {
          // 先以旧计数评估预测是否应验（关系桶同样摊成招式分布后再取最大），再累加新计数
          const probs = isRel
            ? expandRel(b, this.options.alpha, ref)
            : laplace(b, this.options.alpha);
          const pred = argmaxProbs(probs);
          e.tries = e.tries * decay + 1;
          e.hits = e.hits * decay + (pred === humanMove ? 1 : 0);
        }
        if (decay < 1) {
          for (const k in b) b[k] *= decay;
        }
        // 关系桶记「本招相对参照招的关系」，出招桶记本招本身
        if (isRel) b[relation(humanMove, ref)]++;
        else b[humanMove]++;
      }
    }

    /**
     * 突变检测：窗口内某招密集出现、而它在全部历史里几乎没出现过，就返回一份「向近期窗口靠拢」
     * 的修正量（{ lambda, dist, move, count, window }），否则返回 null。
     * 两个条件缺一不可 —— 只看「最近出现得勤」而不看长期占比的话，随机对手每隔几局就会误触发一次。
     */
    surgeProfile(history) {
      const W = SURGE.window;
      const len = history.length;
      if (len < SURGE.minHistory || len < W) return null;

      const wc = { R: 0, P: 0, S: 0 };
      for (let i = len - W; i < len; i++) wc[history[i].human]++;
      const all = { R: 0, P: 0, S: 0 };
      for (let i = 0; i < len; i++) all[history[i].human]++;
      const total = all.R + all.P + all.S;
      if (!total) return null;

      let best = null;
      for (const m of MOVES) {
        if (wc[m] < SURGE.minCount) continue;                 // 最近没怎么出现
        if (all[m] / total >= SURGE.rareShare) continue;       // 历史上并不罕见（模型自己学得到，不必插手）
        const raw = (wc[m] / W - 1 / 3) / (1 - 1 / 3);        // 窗口占比越过随机基准多少
        if (raw <= 0) continue;
        if (!best || raw > best.raw) best = { move: m, raw };
      }
      if (!best) return null;

      return {
        lambda: Math.min(SURGE.maxLambda, best.raw),
        dist: laplace(wc, Math.max(0.2, Number(this.options.alpha) || 0.5)),
        move: best.move,
        count: wc[best.move],
        window: W,
      };
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
        const n = b ? bucketSum(b, e.mode) : 0;
        if (!b || n === 0) {
          breakdown.push({ expert: e, matched: false, key });
          continue;
        }

        const isRel = e.mode === 'result';
        // 关系桶的参照招 = 上一局出的招（预测时已确定），关系分布据此摊回三招
        const refMove = isRel ? e.refFor(history, history.length) : null;
        const probs = isRel
          ? expandRel(b, this.options.alpha, refMove)
          : laplace(b, this.options.alpha);
        const conf = n / (n + 1);                 // 样本越多越自信（早期折扣较宽，让应验率尽早生效）
        // 样本收缩：应验率向 1/3 基准收缩（zOpt 为强度，0 = 直接用应验率）
        const accEst = zOpt > 0 ? shrink(e.accuracy, e.tries, zOpt) : e.accuracy;
        const weight = Math.max(0, accEst - 1 / 3) * conf;
        for (const m of MOVES) acc[m] += weight * probs[m];
        weightSum += weight;

        const top = argmaxProbs(probs);
        breakdown.push({
          expert: e,
          matched: true,
          key,
          counts: isRel
            ? { win: b.win, lose: b.lose, draw: b.draw }
            : { R: b.R, P: b.P, S: b.S },
          probs,
          weight,
          accuracy: e.accuracy,
          tries: e.tries,
          // 关系桶展示的是关系预测（胜/负/平），出招桶展示的是招式
          prediction: isRel ? relation(top, refMove) : top,
          refMove,
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
      // 突变检测：猜测分布先向「最近这几局」靠一靠（详见 SURGE 的说明）
      const surge = this.surgeProfile(history);
      if (surge) {
        for (const m of MOVES) meta[m] = (1 - surge.lambda) * meta[m] + surge.lambda * surge.dist[m];
      }
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
      // 弃用概率：预测是否已被证明显著劣于随机（同样的检验，方向相反）
      const drop = clamp(Number(this.options.predictDrop) || 0, 0, 1);
      const move = pickMove(meta, { weightSum, epsilon: eps.epsilon, trust, drop, bestCpu });
      // 命中率的尺子 = AI 对下一招的预测（只看预测准不准，与电脑实际出什么招、是否探索无关）
      const target = argmaxProbs(meta);

      return {
        cpuMove: move.cpuMove,
        suggest: move.suggest,                  // 建议招（辅助模式用）——不含探索扰动
        bestCpu,
        bestTies,                               // 期望收益并列最高的招（含 bestCpu，顺序为 MOVES 顺序）
        target,
        metaProbs: meta,
        probs: final,
        breakdown,
        epsilon: eps.epsilon,
        explore: move.explore,
        sampled: move.sampled,                  // 本局是否「预测不显著 → 按分布取样」（未押注最优招）
        dropped: move.dropped,                  // 本局是否「预测显著劣于随机 → 弃用预测」（改回均匀随机）
        trust,                                  // 本局的押注概率（0 = 从不押注，1 = 总是押注）
        drop,                                   // 本局的弃用概率（0 = 从不弃用）
        earlyRandom: eps.earlyRandom,           // ε 是否由前期随机度主导
        earlyRand: eps.earlyRand,               // 前期随机度数值（不受上限约束）
        adaptiveEps: eps.adaptiveEps,           // 自适应扰动（不受上限约束）
        exploreScale: eps.exploreScale,         // 探索强度档位（受上限约束）
        avgAcc: weightedAccuracy(breakdown),
        weightSum,                              // 归一化前总权重（0 = 没有任何可信标准）
        scores,                                 // 三招各自的期望收益（赢−输）
        surge,                                  // 本次预测是否触发了突变修正（null = 未触发）
      };
    }
  }

  global.RPS.Expert = Expert;
  global.RPS.Predictor = Predictor;
})(window);
