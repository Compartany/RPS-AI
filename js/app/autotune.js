/*!
 * RPS-AI · 自动调参
 *
 * 四项参数（α / 探索强度 / 样本收缩 / 记忆半衰期）的在线择优，
 * 以及它们共用的显著性检验与加权统计工具。
 */
(function (global) {
  'use strict';

  const App = global.RPSApp;
  const { els, state } = App;              // predictor 一律走 App.predictor（切模式 / 重置时会被整体替换）
  const { clamp, weightedMean } = global.RPS;

  /* ============================== 统计工具 ============================== */

  /**
   * 单侧显著性检验：把一串「命中 / 未命中」记录按半衰期加权，与随机基准 1/3 比较。
   *   · Agresti-Coull 平滑（+2 命中 +2 未命中）—— 避免 w 贴近 1/3 或 1 时公式退化
   *   · 有效样本量取 Kish 值 (Σw)² / Σw²  —— 越近的局权重越大，但不会虚增自由度
   * @param records   记录数组
   * @param hl        半衰期（局），0 = 等权
   * @param direction +1 检验「高于 1/3」（押注），−1 检验「低于 1/3」（探索）
   * @param isHit     判定某条记录是否算命中
   * @param isDraw    （可选）判定某条记录是否应剔除
   * @returns {{w:number, nEff:number, z:number}|null} sw = 0 时返回 null
   */
  function zTest(records, hl, direction, isHit, isDraw) {
    const n = records.length;
    let sw = 0;
    let swh = 0;
    let sw2 = 0;
    for (let i = 0; i < n; i++) {
      if (isDraw && isDraw(records[i])) continue;
      const w = Math.pow(0.5, (n - 1 - i) / hl);
      sw += w;
      sw2 += w * w;
      if (isHit(records[i])) swh += w;
    }
    if (!(sw > 0)) return null;

    const w = (swh + 2) / (sw + 4);
    const nEff = sw2 ? (sw * sw) / sw2 : 0;
    const sigma = Math.sqrt((w * (1 - w)) / (nEff + 4));
    const z = sigma > 0 ? (direction * (w - 1 / 3)) / sigma : 0;
    return { w, nEff, z };
  }

  /** 由 z 映射到「强度」0~1：z ≤ 1 视为无显著差异，z ≥ 3 拉满 */
  const zStrength = (z) => clamp((z - 1) / 2, 0, 1);

  /** 在候选档位里找最接近 value 的那一档的下标 */
  function nearestTier(tiers, value) {
    let cur = 0;
    for (let i = 1; i < tiers.length; i++) {
      if (Math.abs(tiers[i] - value) < Math.abs(tiers[cur] - value)) cur = i;
    }
    return cur;
  }

  /** 从 cur 档朝 best 档移动，每局最多移动一档（避免参数跳变） */
  const stepToward = (cur, best) => (cur === best ? cur : cur + Math.sign(best - cur));

  /** 从第 0 档起挑「明显更优」者：越高档必须超出 margin 才升级，否则一律退回第 0 档 */
  function bestTierByRate(rates, margin) {
    let best = 0;
    for (let i = 1; i < rates.length; i++) {
      if (rates[i] > rates[best] + margin) best = i;
    }
    return best;
  }

  /**
   * AI 预测命中率的两个口径：
   *   a = 全部统计（所有对局等权）
   *   b = 按半衰期加权（近局权重更大）
   *   n = 加权有效样本量（Kish 有效样本数 (Σw)² / Σw²）
   */
  function hitStats() {
    const a = state.hitTries ? state.hit / state.hitTries : null;
    const hl = Number(App.predictor.options.halfLife) || 16;
    const log = state.hitLog;
    const len = log.length;
    if (!len) return { a, b: a, n: state.hitTries };

    let sw = 0;
    let swh = 0;
    let sw2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.pow(0.5, (len - 1 - i) / hl);
      sw += w;
      sw2 += w * w;
      swh += w * log[i];
    }
    return { a, b: sw ? swh / sw : a, n: sw2 ? (sw * sw) / sw2 : state.hitTries };
  }

  /* ============================== 档位择优 ============================== */

  const ALPHA = { base: 1.6, slope: 0.01, lo: 0.3, hi: 1.5 };  // α = base − 局数 × slope，夹在 [lo, hi]
  const TIER_MARGIN = 0.03;                                     // 档位升级门槛（命中率高出的百分点）

  /**
   * 探索强度：上限由「按最优出招的胜率是否显著低于 1/3」决定。
   * 只有当对手已能反制它、它照预测出招反而赢不了时，才允许加入随机；
   * 这样「预测本来就不可靠」不会被误判成「被针对」。
   */
  function tuneExplore(baseHl) {
    const blog = state.bestLog.slice(-App.Z_WINDOW);
    let maxExplore = 0;
    let exploreStat = null;
    if (blog.length >= App.Z_MIN_SAMPLES) {
      const st = zTest(blog, baseHl, -1, (v) => v === 'cpu', (v) => v === 'draw');
      if (st) {
        maxExplore = zStrength(st.z);
        exploreStat = st;
      }
    }
    state.exploreCap = maxExplore;
    state.exploreStat = exploreStat;

    // 目标档位：不超上限的最高档；每局最多朝它移动一档
    const allowed = App.EXPLORE_TIERS.filter((v) => v <= maxExplore + 1e-9);
    const target = allowed.length ? allowed[allowed.length - 1] : 0;
    const cur = nearestTier(App.EXPLORE_TIERS, App.predictor.options.exploreScale);
    const scale = App.EXPLORE_TIERS[stepToward(cur, App.EXPLORE_TIERS.indexOf(target))];

    els.epsInput.value = String(Math.round(scale * 100));
    els.epsOut.textContent = Math.round(scale * 100) + '%';
    App.predictor.options.exploreScale = scale;
  }

  /**
   * 样本收缩：比较各档位的「预测命中率」决定用哪一档（命中率越高 = 预测越准）。
   * 统一以「当前半衰期」为权重基准，近期对局权重更大。
   */
  function tuneConfidence(baseHl) {
    let z = Number(els.confInput.value);
    const win = state.shadow.slice(-App.Z_WINDOW);
    if (win.length) {
      const rates = App.Z_CANDIDATES.map((_, i) => weightedMean(win.map((r) => r[i]), baseHl));
      state.rateTable = App.Z_CANDIDATES.map((zz, i) => ({ z: zz, rate: rates[i] }));

      if (win.length >= App.Z_MIN_SAMPLES) {
        const best = bestTierByRate(rates, TIER_MARGIN);
        z = App.Z_CANDIDATES[stepToward(nearestTier(App.Z_CANDIDATES, z), best)];
      }
    } else {
      state.rateTable = null;
    }
    els.confInput.value = z.toFixed(1);
    els.confOut.textContent = z.toFixed(1);
    App.predictor.options.confidence = z;
  }

  /**
   * 记忆衰减：各半衰期档位比较「预测命中率」，且各自按自己的半衰期加权
   * （短记忆只看近期表现）。返回半衰期是否发生变化（调用方据此决定要不要重放历史）。
   */
  function tuneHalfLife() {
    let hl = Number(els.hlInput.value);
    const dwin = state.decayShadow.slice(-App.Z_WINDOW);
    if (dwin.length) {
      const rates = App.DECAY_TIERS.map((v, i) => weightedMean(dwin.map((r) => r[i]), v));
      state.decayRateTable = App.DECAY_TIERS.map((v, i) => ({ hl: v, rate: rates[i] }));

      if (dwin.length >= App.Z_MIN_SAMPLES) {
        const best = bestTierByRate(rates, TIER_MARGIN);
        hl = App.DECAY_TIERS[stepToward(nearestTier(App.DECAY_TIERS, hl), best)];
      }
    } else {
      state.decayRateTable = null;
    }
    els.hlInput.value = String(hl);
    els.hlOut.textContent = hl + ' 局';

    if (App.predictor.options.halfLife !== hl) {
      App.predictor.options.halfLife = hl;   // 换了衰减速度，调用方得按新规则重放历史
      return true;
    }
    return false;
  }

  /** 自动调参一步：α 随样本量降低；探索强度 / 样本收缩 / 记忆半衰期按实测表现择优 */
  function autoTuneStep() {
    if (!els.autoInput.checked) return;

    // α：对局越多越少平滑（越相信经验数据）
    const alpha = clamp(ALPHA.base - state.history.length * ALPHA.slope, ALPHA.lo, ALPHA.hi);
    const alphaChanged = Math.abs(alpha - App.predictor.options.alpha) > 1e-9;
    App.predictor.options.alpha = alpha;
    els.alphaInput.value = alpha.toFixed(1);
    els.alphaOut.textContent = alpha.toFixed(1);

    // 各档位评估统一用「当前半衰期」作为权重基准（近期对局权重更大）
    const baseHl = Number(App.predictor.options.halfLife) || 16;

    tuneExplore(baseHl);
    tuneConfidence(baseHl);
    const halfLifeChanged = tuneHalfLife();

    // α / 半衰期任一变化，都得回放全部历史重新评估各标准的应验率
    if (alphaChanged || halfLifeChanged) App.predictor.replay(App.predView());
    // 各半衰期档位模型也得跟上主模型的参数，否则面板上那份档位命中率是另一套参数下测的
    App.syncDecayModels(alphaChanged);
  }

  /**
   * 押注判定：只有「AI 预测命中率」显著高于随机基准 1/3，才值得按最优招押注。
   * 预测未被证明有用时，`decide` 会改按预测分布取样 —— argmax 是确定性函数，
   * 靠噪声排出的「最优招」排序一旦固定，AI 就会长期出同一招，极易被反制。
   * 与探索上限同一套口径（Agresti-Coull 平滑 + Kish 有效样本量 + 单侧 z 检验），方向相反。
   */
  function syncPredictTrust() {
    const hl = Number(App.predictor.options.halfLife) || 16;
    const win = state.hitLog.slice(-App.Z_WINDOW);
    let stat = null;
    let trust = 0;
    if (win.length >= App.Z_MIN_SAMPLES) {
      const st = zTest(win, hl, +1, (v) => !!v);
      if (st) {
        trust = zStrength(st.z);
        stat = Object.assign({}, st, { trust });
      }
    }
    state.predictStat = stat;
    state.predictTrust = trust;
    App.predictor.options.predictTrust = trust;
  }

  Object.assign(App, { hitStats, autoTuneStep, syncPredictTrust });
})(window);
