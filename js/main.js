/*!
 * RPS-Duel · 界面与流程
 */
(function () {
  'use strict';

  const { MOVES, NAMES, EMOJI, Predictor, judge, relation, randInt } = window.RPS;
  const NIST = window.RPS_NIST;

  const $ = (id) => document.getElementById(id);
  const els = {
    layout: $('layout'),
    panel: $('panel'),
    panelBtn: $('panelBtn'),
    panelClose: $('panelClose'),
    sortSeg: $('sortSeg'),
    resetBtn: $('resetBtn'),
    nistBtn: $('nistBtn'),
    nistModal: $('nistModal'),
    nistBackdrop: $('nistBackdrop'),
    nistClose: $('nistClose'),
    nistBody: $('nistBody'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    importFile: $('importFile'),
    choices: $('choices'),
    cpuMove: $('cpuMove'),
    cpuTag: $('cpuTag'),
    humanTag: $('humanTag'),
    resultBanner: $('resultBanner'),
    cpuRate: $('cpuRate'),
    drawRate: $('drawRate'),
    humanRate: $('humanRate'),
    barCpu: $('barCpu'),
    barHuman: $('barHuman'),
    totalRounds: $('totalRounds'),
    streak: $('streak'),
    hitRate: $('hitRate'),
    hitRateWrap: $('hitRateWrap'),
    idealRate: $('idealRate'),
    forecast: $('forecast'),
    criteriaBody: $('criteriaBody'),
    lastCpuMove: $('lastCpuMove'),
    records: $('records'),
    historyStats: $('historyStats'),
    alphaInput: $('alphaInput'),
    alphaOut: $('alphaOut'),
    confInput: $('confInput'),
    confOut: $('confOut'),
    confCompare: $('confCompare'),
    hlInput: $('hlInput'),
    hlOut: $('hlOut'),
    hlCompare: $('hlCompare'),
    exploreCompare: $('exploreCompare'),
    predictCompare: $('predictCompare'),
    randomness: $('randomness'),
    autoInput: $('autoInput'),
    paramReset: $('paramReset'),
    epsInput: $('epsInput'),
    epsOut: $('epsOut'),
    exploreInput: $('exploreInput'),
  };

  const state = {
    history: [],                       // [{ human, cpu }]
    stats: { cpu: 0, human: 0, draw: 0 },
    pending: null,                     // 本局电脑已选好的招 + 依据
    revealed: false,
    revealedMove: null,
    hit: 0,
    hitTries: 0,
    hitLog: [],                        // 每局 AI 预测是否命中（1/0），供半衰期加权的命中率使用
    ideal: { win: 0, lose: 0 },        // 假设从不探索、始终按最优预测出招时的胜负
    bestLog: [],                       // 每局「按最优出招」的胜负（'cpu'/'human'/'draw'），用于估计探索上限
    lastAvgAcc: null,                  // 上一局各参与标准的加权平均应验率
    streak: { side: null, count: 0 },
    lastResult: null,
    shadow: [],                        // 每局各收缩档位的预测是否命中（1/0）
    shadowTargets: null,               // 本局各收缩档位的预测招
    rateTable: null,                   // 各档位在最近窗口的命中率（供面板展示）
    decayShadow: [],                   // 每局各半衰期档位的预测是否命中（1/0）
    decayTargets: null,                // 本局各半衰期档位的预测招
    decayRateTable: null,              // 各半衰期档位在最近窗口的命中率
    exploreStat: null,                 // 探索上限的判定过程 { w, nEff, z }
    exploreCap: 0,                     // 探索上限（由显著性检验得出）
    predictStat: null,                 // 押注判定的过程 { w, nEff, z, trust }
    predictTrust: 0,                   // 押注概率（0 = 预测不显著，改按分布取样）
  };

  // 记忆阶数：固定为 3（不再支持自定义；阶数越高越关注长序列规律，但样本需求也越大）
  const ORDER = 3;

  const readOptions = () => ({
    alpha: Number(els.alphaInput.value),
    exploreScale: Number(els.epsInput.value) / 100,
    explore: els.exploreInput.checked,
    confidence: Number(els.confInput.value),
    halfLife: Number(els.hlInput.value),
  });
  const newPredictor = (N) => new Predictor(N, readOptions());

  let predictor = newPredictor(ORDER);
  let panelSort = 'weight';  // 'weight' 按权重 | 'acc' 按应验率 | 'default' 默认顺序

  // 自动调参：候选的样本收缩档位（0 = 完全按应验率加权）、评估窗口与最少样本
  const Z_CANDIDATES = [0, 0.5, 1, 1.5, 2];
  const Z_WINDOW = 40;
  const Z_MIN_SAMPLES = 12;
  // 记忆衰减档位（半衰期，局），取 2 的幂便于按对数均匀覆盖；0 = 不遗忘
  const DECAY_TIERS = [0, 64, 32, 16, 8];

  // 探索强度档位（保底纯随机概率），从低到高；自动调参在此之间按电脑胜率择优
  const EXPLORE_TIERS = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 1];

  // 每个半衰期档位维护一份独立模型，同时学习同一份历史，用于比较电脑胜率
  let decayModels = [];
  function rebuildDecayModels() {
    const N = ORDER;
    decayModels = DECAY_TIERS.map((hl) =>
      new Predictor(N, Object.assign(readOptions(), { halfLife: hl }))
    );
    for (const m of decayModels) m.replay(state.history);
  }

  /* ------------------------------ 出招日志（证明电脑没作弊） ------------------------------ */

  /** 电脑选定出招时（你尚未出招）打印一条结构化日志：彩色标签 + 可展开的详情对象 */
  function logCpuMove(round, d) {
    const source = d.explore ? '探索随机' : d.sampled ? '按分布取样' : '押注最优招';
    const t = new Date();
    const hhmmss = t.toLocaleTimeString('zh-CN', { hour12: false })
      + '.' + String(t.getMilliseconds()).padStart(3, '0');
    console.log(
      `%cRPS%c 第 ${round} 局 %c${EMOJI[d.cpuMove]} ${NAMES[d.cpuMove]}(${d.cpuMove})%c  ·  ${source}  ·  ${hhmmss}`,
      'background:#7b6cff;color:#fff;border-radius:4px;padding:1px 5px;font-weight:700',
      'color:#a6afc9',
      'color:#ffd76a;font-weight:700',
      null,
      {
        局号: round,
        电脑出招: `${NAMES[d.cpuMove]}(${d.cpuMove})`,
        决策来源: source,
        预测你出: `${NAMES[d.target]}(${d.target})`,
        预测最大概率: Math.max(d.metaProbs.R, d.metaProbs.P, d.metaProbs.S),
        探索概率: d.epsilon,
        押注概率: d.trust,
        时间戳: t.toISOString(),
      }
    );
  }

  /* ------------------------------ 流程 ------------------------------ */

  function startRound() {
    syncPredictTrust();
    state.pending = predictor.decide(state.history);
    // 影子：各收缩档位在同一局面下的「预测招」，用于赛后比较预测命中率（不含探索）
    state.shadowTargets = Z_CANDIDATES.map((zz) => predictor.decide(state.history, zz).target);
    // 影子：各记忆半衰期档位（各持一份模型）在同一局面下的「预测招」
    state.decayTargets = decayModels.map((m) => m.decide(state.history).target);
    if (state.pending && state.pending.avgAcc != null) state.lastAvgAcc = state.pending.avgAcc;
    state.revealed = false;
    state.revealedMove = null;
    logCpuMove(state.history.length + 1, state.pending);   // 出招已定，立刻打日志（你还没出招）
    renderArena();
    renderPanel();
  }

  function play(move) {
    if (state.revealed) startRound(); // 展示期间再次出招 → 立即开新局，不丢输入

    const cpu = state.pending.cpuMove;
    const result = judge(move, cpu);

    state.revealed = true;
    state.revealedMove = move;
    state.lastResult = result;
    state.stats[result]++;

    state.hitTries++;
    const hitThisRound = state.pending.target === move;
    if (hitThisRound) state.hit++;
    state.hitLog.push(hitThisRound ? 1 : 0);
    if (state.hitLog.length > 5000) state.hitLog.splice(0, state.hitLog.length - 5000);

    // 若这局不探索（始终按最优预测出招）的胜负，用于「最优胜率」与探索上限估计
    const idealRes = judge(move, state.pending.bestCpu);
    if (idealRes === 'cpu') state.ideal.win++;
    else if (idealRes === 'human') state.ideal.lose++;
    state.bestLog.push(idealRes);
    if (state.bestLog.length > Z_WINDOW * 3) state.bestLog.splice(0, state.bestLog.length - Z_WINDOW * 3);

    // 影子战绩：各收缩档位的预测是否命中你实际出招
    if (state.shadowTargets) {
      state.shadow.push(state.shadowTargets.map((t) => (t === move ? 1 : 0)));
      const keep = Z_WINDOW * 3;
      if (state.shadow.length > keep) state.shadow.splice(0, state.shadow.length - keep);
    }

    // 影子战绩：各记忆半衰期档位的预测是否命中你实际出招
    if (state.decayTargets) {
      state.decayShadow.push(state.decayTargets.map((t) => (t === move ? 1 : 0)));
      const keep = Z_WINDOW * 3;
      if (state.decayShadow.length > keep) state.decayShadow.splice(0, state.decayShadow.length - keep);
    }

    // 影子战绩：各探索档位已在 autoTuneStep 中直接由显著性检验决定，无需再记战绩

    if (result === 'draw') {
      state.streak = { side: null, count: 0 };
    } else if (state.streak.side === result) {
      state.streak.count++;
    } else {
      state.streak = { side: result, count: 1 };
    }

    predictor.learn(state.history, move);
    for (const m of decayModels) m.learn(state.history, move);
    state.history.push({ human: move, cpu });

    autoTuneStep();

    renderScores();
    renderArena();
    renderPanel();
    renderHistory();

    setTimeout(() => {
      if (state.revealed) startRound();
    }, 850);
  }

  function resetAll() {
    state.history = [];
    state.stats = { cpu: 0, human: 0, draw: 0 };
    state.hit = 0;
    state.hitTries = 0;
    state.hitLog = [];
    state.ideal = { win: 0, lose: 0 };
    state.bestLog = [];
    state.streak = { side: null, count: 0 };
    state.lastResult = null;
    state.shadow = [];
    state.shadowTargets = null;
    state.rateTable = null;
    state.decayShadow = [];
    state.decayTargets = null;
    state.decayRateTable = null;
    state.exploreStat = null;
    state.predictStat = null;
    state.predictTrust = 0;
    predictor = newPredictor(ORDER);
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
  }

  /* ------------------------------ 存档 ------------------------------ */

  // 私有紧凑格式（单行）：
  // RPSD1|阶数|α|探索强度(0~1)|探索开关|自动调参|统计数字|历史|命中记录
  //  统计数字 = cpu,human,draw,hit,hitTries,idealWin,idealLose,confidence,halfLife
  //  历史 = 每局 2 个字符（人类招 + 电脑招）；命中记录 = 每局 1 个字符（1/0，AI 预测是否命中）
  function buildSave() {
    const hist = state.history.map((r) => r.human + r.cpu).join('');
    const nums = [
      state.stats.cpu, state.stats.human, state.stats.draw,
      state.hit, state.hitTries,
      state.ideal.win, state.ideal.lose,
      predictor.options.confidence,
      predictor.options.halfLife,
    ].join(',');
    return [
      'RPSD1',
      ORDER,
      predictor.options.alpha,
      predictor.options.exploreScale,
      els.exploreInput.checked ? 1 : 0,
      els.autoInput.checked ? 1 : 0,
      nums,
      hist,
      state.hitLog.join(''),
    ].join('|') + '\n';
  }

  function parseSave(text) {
    const parts = String(text).trim().split('|');
    if (parts[0] !== 'RPSD1') throw new Error('不是有效的存档文件');
    const nums = (parts[6] || '').split(',').map(Number);
    const hist = parts[7] || '';
    if (hist.length % 2 !== 0) throw new Error('历史数据长度异常');

    const ok = (c) => MOVES.indexOf(c) >= 0;
    const history = [];
    for (let i = 0; i < hist.length; i += 2) {
      if (ok(hist[i]) && ok(hist[i + 1])) history.push({ human: hist[i], cpu: hist[i + 1] });
    }
    return {
      order: Number(parts[1]) || 3,
      options: {
        alpha: Number(parts[2]) || 1,
        exploreScale: parts[3] != null ? Number(parts[3]) : 0.1,
        explore: parts[4] !== '0',
      },
      autoTune: parts[5] !== '0',
      stats: { cpu: nums[0] | 0, human: nums[1] | 0, draw: nums[2] | 0 },
      hit: nums[3] | 0,
      hitTries: nums[4] | 0,
      ideal: { win: nums[5] | 0, lose: nums[6] | 0 },
      confidence: nums[7] != null && !isNaN(nums[7]) ? nums[7] : 1,
      halfLife: nums[8] != null && !isNaN(nums[8]) ? nums[8] : 16,
      hitLog: (parts[8] || '').split('').map((c) => (c === '1' ? 1 : 0)),
      history,
    };
  }

  function exportSave() {
    const blob = new Blob([buildSave()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rps-duel-${new Date().toISOString().slice(0, 10)}.rps`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importSave(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applySave(parseSave(reader.result));
      } catch (err) {
        alert('存档导入失败：' + err.message);
      }
    };
    reader.onerror = () => alert('存档读取失败');
    reader.readAsText(file);
  }

  function applySave(d) {
    if (!d || !Array.isArray(d.history)) throw new Error('格式不正确（缺少 history）');

    state.history = d.history
      .filter((r) => r && MOVES.indexOf(r.human) >= 0 && MOVES.indexOf(r.cpu) >= 0)
      .map((r) => ({ human: r.human, cpu: r.cpu }));
    state.stats = Object.assign({ cpu: 0, human: 0, draw: 0 }, d.stats || {});
    state.hit = d.hit | 0;
    state.hitTries = d.hitTries | 0;
    state.hitLog = Array.isArray(d.hitLog) ? d.hitLog.slice(-5000) : [];
    state.ideal = Object.assign({ win: 0, lose: 0 }, d.ideal || {});
    state.bestLog = [];
    state.streak = { side: null, count: 0 };
    state.lastResult = null;

    const opt = d.options || {};
    if (opt.alpha != null) els.alphaInput.value = String(opt.alpha);
    if (opt.exploreScale != null) els.epsInput.value = String(Math.round(opt.exploreScale * 100));
    els.exploreInput.checked = opt.explore !== false;
    els.confInput.value = String(d.confidence != null ? d.confidence : 1);
    els.hlInput.value = String(d.halfLife != null ? d.halfLife : 16);
    els.alphaOut.textContent = Number(els.alphaInput.value).toFixed(1);
    els.epsOut.textContent = Math.round(Number(els.epsInput.value)) + '%';
    els.confOut.textContent = Number(els.confInput.value).toFixed(1);
    els.hlOut.textContent = Number(els.hlInput.value) > 0 ? Number(els.hlInput.value) + ' 局' : '不遗忘';
    els.autoInput.checked = d.autoTune !== false;

    state.shadow = [];
    state.shadowTargets = null;
    state.rateTable = null;
    state.decayShadow = [];
    state.decayTargets = null;
    state.decayRateTable = null;
    state.exploreStat = null;
    state.predictStat = null;
    state.predictTrust = 0;
    predictor = newPredictor(Number(els.orderInput.value));
    predictor.replay(state.history);
    rebuildDecayModels();

    syncParamDisabled();

    autoTuneStep();
    renderScores();
    renderHistory();
    startRound();
  }

  /** 参数控件可用性：自动调参接管时锁定；探索扰动关掉后探索强度也锁定 */
  function syncParamDisabled() {
    const auto = els.autoInput.checked;
    const exploreOff = !els.exploreInput.checked;
    const setLock = (el, lockedByAuto, off) => {
      el.disabled = lockedByAuto || off;
      el.dataset.lock = off ? 'off' : lockedByAuto ? 'auto' : '';
    };
    setLock(els.alphaInput, auto, false);
    setLock(els.confInput, auto, false);
    setLock(els.hlInput, auto, false);
    setLock(els.epsInput, auto, exploreOff);
  }

  /** 时间加权平均：arr 由旧到新，hl 为半衰期（局）；hl = 0 时等权 */
  function wavg(arr, hl) {
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

  /** 自动调参：α 随样本量降低；探索强度 / 样本收缩 / 记忆半衰期按实测表现择优 */
  function autoTuneStep() {
    if (!els.autoInput.checked) return;

    // α：对局越多越少平滑（越相信经验数据）
    const total = state.history.length;
    const alpha = Math.min(1.5, Math.max(0.3, 1.6 - total * 0.01));
    const alphaChanged = Math.abs(alpha - predictor.options.alpha) > 1e-9;
    predictor.options.alpha = alpha;
    els.alphaInput.value = alpha.toFixed(1);
    els.alphaOut.textContent = alpha.toFixed(1);

    // 各档位评估统一用「当前半衰期」作为权重基准（近期对局权重更大）
    const baseHl = Number(predictor.options.halfLife) || 0;

    // 探索强度上限：只有「按最优出招」的胜率 w 显著低于随机基准 1/3，才允许开启随机。
    // 用单侧显著性 z = (1/3 − w) / σ（σ = √(w(1−w)/n_eff)，剔除平局、按半衰期加权取 Kish 有效样本量），
    // 再平滑映射成上限：z ≤ 1 → 0；z = 2 → 50%；z ≥ 3 → 100%。
    // 这样“预测本来就不可靠”不会被误判成“被针对”。
    const blog = state.bestLog.slice(-Z_WINDOW);
    let maxExplore = 0;
    let exploreStat = null;
    if (blog.length >= Z_MIN_SAMPLES) {
      let sw = 0;
      let swh = 0;
      let sw2 = 0;
      for (let i = 0; i < blog.length; i++) {
        if (blog[i] === 'draw') continue;                       // 平局剔除
        const wt = baseHl ? Math.pow(0.5, (blog.length - 1 - i) / baseHl) : 1;
        sw += wt;
        sw2 += wt * wt;
        if (blog[i] === 'cpu') swh += wt;
      }
      if (sw > 0) {
        // Agresti-Coull 平滑（+2 胜 +2 负的伪计数），避免 w=0 时 σ=0 导致公式退化
        const w = (swh + 2) / (sw + 4);
        const nEff = sw2 ? (sw * sw) / sw2 : 0;
        const sigma = Math.sqrt((w * (1 - w)) / (nEff + 4));
        const z = sigma > 0 ? (1 / 3 - w) / sigma : 0;
        maxExplore = Math.min(1, Math.max(0, (z - 1) / 2));
        exploreStat = { w, nEff, z };
      }
    }
    state.exploreCap = maxExplore;
    state.exploreStat = exploreStat;
    // 目标档位：不超上限的最高档
    const allowed = EXPLORE_TIERS.filter((v) => v <= maxExplore + 1e-9);
    const targetScale = allowed.length ? allowed[allowed.length - 1] : 0;

    let scale = predictor.options.exploreScale;
    {
      let cur = 0;
      for (let i = 1; i < EXPLORE_TIERS.length; i++) {
        if (Math.abs(EXPLORE_TIERS[i] - scale) < Math.abs(EXPLORE_TIERS[cur] - scale)) cur = i;
      }
      const ti = EXPLORE_TIERS.indexOf(targetScale);
      if (ti !== cur) cur += Math.sign(ti - cur);   // 每局最多移动一档
      scale = EXPLORE_TIERS[cur];
    }
    els.epsInput.value = String(Math.round(scale * 100));
    els.epsOut.textContent = Math.round(scale * 100) + '%';
    predictor.options.exploreScale = scale;

    // 样本收缩：比较各档位的「预测命中率」决定用哪一档（命中率越高 = 预测越准）。
    // 统一以「当前半衰期」为权重基准，近期对局权重更大。
    let z = Number(els.confInput.value);
    const win = state.shadow.slice(-Z_WINDOW);
    if (win.length) {
      const rates = Z_CANDIDATES.map((_, i) => wavg(win.map((r) => r[i]), baseHl));
      state.rateTable = Z_CANDIDATES.map((zz, i) => ({ z: zz, rate: rates[i] }));

      if (win.length >= Z_MIN_SAMPLES) {
        let best = 0;
        for (let i = 1; i < rates.length; i++) {
          if (rates[i] > rates[best] + 0.03) best = i;
        }
        let cur = 0;
        for (let i = 1; i < Z_CANDIDATES.length; i++) {
          if (Math.abs(Z_CANDIDATES[i] - z) < Math.abs(Z_CANDIDATES[cur] - z)) cur = i;
        }
        if (best !== cur) cur += Math.sign(best - cur);   // 每局最多移动一档，避免参数跳变
        z = Z_CANDIDATES[cur];
      }
    } else {
      state.rateTable = null;
    }
    els.confInput.value = z.toFixed(1);
    els.confOut.textContent = z.toFixed(1);
    predictor.options.confidence = z;

    // 记忆衰减：各半衰期档位比较「预测命中率」，且各自按自己的半衰期加权（短记忆只看近期表现）
    let hl = Number(els.hlInput.value);
    const dwin = state.decayShadow.slice(-Z_WINDOW);
    if (dwin.length) {
      const drates = DECAY_TIERS.map((v, i) => wavg(dwin.map((r) => r[i]), v));
      state.decayRateTable = DECAY_TIERS.map((v, i) => ({ hl: v, rate: drates[i] }));

      if (dwin.length >= Z_MIN_SAMPLES) {
        let best = 0;
        for (let i = 1; i < drates.length; i++) {
          if (drates[i] > drates[best] + 0.03) best = i;
        }
        let cur = 0;
        for (let i = 1; i < DECAY_TIERS.length; i++) {
          if (Math.abs(DECAY_TIERS[i] - hl) < Math.abs(DECAY_TIERS[cur] - hl)) cur = i;
        }
        if (best !== cur) cur += Math.sign(best - cur);   // 每局最多移动一档
        hl = DECAY_TIERS[cur];
      }
    } else {
      state.decayRateTable = null;
    }
    els.hlInput.value = String(hl);
    els.hlOut.textContent = hl > 0 ? hl + ' 局' : '不遗忘';
    if (predictor.options.halfLife !== hl) {
      predictor.options.halfLife = hl;
      predictor.replay(state.history);   // 换了衰减速度，得按新规则重放历史
    }

    if (alphaChanged) predictor.replay(state.history);
  }

  /**
   * 押注判定：只有「AI 预测命中率」显著高于随机基准 1/3，才值得按最优招押注。
   * 预测未被证明有用时，`decide` 会改按预测分布取样——argmax 是确定性函数，
   * 靠噪声排出的「最优招」排序一旦固定，AI 就会长期出同一招，极易被反制。
   * 与探索上限同一套口径（Agresti-Coull 平滑 + Kish 有效样本量 + 单侧 z 检验），方向相反：
   * z ≤ 1 → 不押注（0），z = 2 → 50%，z ≥ 3 → 100%。
   */
  function syncPredictTrust() {
    const hl = Number(predictor.options.halfLife) || 0;
    const win = state.hitLog.slice(-Z_WINDOW);
    let stat = null;
    let trust = 0;
    if (win.length >= Z_MIN_SAMPLES) {
      let sw = 0;
      let swh = 0;
      let sw2 = 0;
      for (let i = 0; i < win.length; i++) {
        const wt = hl ? Math.pow(0.5, (win.length - 1 - i) / hl) : 1;
        sw += wt;
        sw2 += wt * wt;
        if (win[i]) swh += wt;
      }
      if (sw > 0) {
        // Agresti-Coull 平滑：+2 命中 +2 未命中，避免 w 贴近 1/3/1 时公式退化
        const w = (swh + 2) / (sw + 4);
        const nEff = sw2 ? (sw * sw) / sw2 : 0;
        const sigma = Math.sqrt((w * (1 - w)) / (nEff + 4));
        const z = sigma > 0 ? (w - 1 / 3) / sigma : 0;
        trust = Math.min(1, Math.max(0, (z - 1) / 2));
        stat = { w, nEff, z, trust };
      }
    }
    state.predictStat = stat;
    state.predictTrust = trust;
    predictor.options.predictTrust = trust;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderScores() {
    const total = state.stats.cpu + state.stats.human + state.stats.draw;
    const decisive = state.stats.cpu + state.stats.human;

    // 胜率只按非平局计算；平局率按总对局计算
    const c = decisive ? (state.stats.cpu / decisive) * 100 : 0;
    const h = decisive ? (state.stats.human / decisive) * 100 : 0;
    const d = total ? (state.stats.draw / total) * 100 : 0;

    els.cpuRate.textContent = `${c.toFixed(0)}%`;
    els.humanRate.textContent = `${h.toFixed(0)}%`;
    els.drawRate.textContent = `${d.toFixed(0)}%`;

    els.barCpu.style.width = `${c}%`;
    els.barHuman.style.width = `${h}%`;

    els.totalRounds.textContent = String(total);

    if (state.streak.count >= 2 && state.streak.side) {
      const who = state.streak.side === 'human' ? '你' : '电脑';
      els.streak.textContent = `${who} ${state.streak.count} 连胜`;
      els.streak.className = 'b-' + state.streak.side;
    } else {
      els.streak.textContent = '—';
      els.streak.className = '';
    }

    const hs = hitStats();
    // 提示只挂在整条（#hitRateWrap）上；#hitRate 上残留的 data-tip 要清掉，否则会弹出两条
    els.hitRate.removeAttribute('data-tip');
    els.hitRate.removeAttribute('title');
    if (hs.a == null) {
      els.hitRate.textContent = '—';
      els.hitRateWrap.title = 'AI 预测命中率：AI 对你下一招的预测命中你实际出招的比例（与电脑实际出招无关）。';
    } else {
      const a = Math.round(hs.a * 100);
      const b = Math.round((hs.b == null ? hs.a : hs.b) * 100);
      const hl = Number(predictor.options.halfLife) || 0;
      const hlText = hl > 0 ? `半衰期 ${hl} 局` : '不遗忘（等同全部统计）';
      els.hitRate.textContent = `${b}%`;
      els.hitRateWrap.title = 'AI 预测命中率：AI 对你下一招的预测命中你实际出招的比例（与电脑实际出招无关）。'
        + `显示值按${hlText}加权（${b}%），全部统计为 ${a}%。`;
    }

    const idealTotal = state.ideal.win + state.ideal.lose;
    els.idealRate.textContent = idealTotal
      ? `${((state.ideal.win / idealTotal) * 100).toFixed(0)}%`
      : '—';
  }

  function renderArena() {
    const pending = state.pending;

    if (state.revealed) {
      const cpu = pending.cpuMove;
      els.cpuMove.innerHTML = `<span class="glyph">${EMOJI[cpu]}</span>`;
      els.cpuMove.className = 'move-slot reveal';
      els.cpuTag.textContent = `出招：${NAMES[cpu]}`;

      els.choices.classList.add('locked');
      els.choices.querySelectorAll('.choice').forEach((btn) => {
        btn.classList.toggle('picked', btn.dataset.move === state.revealedMove);
      });
      els.humanTag.textContent = `出招：${NAMES[state.revealedMove]}`;
      els.cpuTag.title = '按 F12 打开控制台可查看每局记录（出招、决策来源、预测与时间戳等）。';

      const map = {
        human: ['你赢了！', 'win'],
        cpu: ['电脑赢了', 'lose'],
        draw: ['平局', 'draw'],
      };
      els.resultBanner.textContent = map[state.lastResult][0];
      els.resultBanner.className = 'result-banner ' + map[state.lastResult][1];
    } else {
      els.cpuMove.innerHTML = '<span class="glyph unknown">?</span>';
      els.cpuMove.className = 'move-slot';
      els.cpuTag.textContent = '已出招 · 待揭示';
      els.cpuTag.title = '按 F12 打开控制台可查看每局记录（出招、决策来源、预测与时间戳等）。';

      els.choices.classList.remove('locked');
      els.choices.querySelectorAll('.choice').forEach((btn) => {
        btn.classList.remove('picked');
      });
      els.humanTag.textContent = '请出招';

      els.resultBanner.textContent = '选择你的出招';
      els.resultBanner.className = 'result-banner';
    }

    renderLast();
  }

  function renderLast() {
    const last = state.history[state.history.length - 1];

    // 对手上一轮出招：展示在出招格右侧的小格里
    if (last) {
      els.lastCpuMove.innerHTML = `<span class="glyph">${EMOJI[last.cpu]}</span>`;
      els.lastCpuMove.classList.add('show');
    } else {
      els.lastCpuMove.innerHTML = '';
      els.lastCpuMove.classList.remove('show');
    }

    // 我方上一轮出招：在对应按钮右下角标注胜负
    const res = last ? judge(last.human, last.cpu) : null;
    const tag = { human: ['赢', 'win'], draw: ['平', 'draw'], cpu: ['输', 'lose'] };
    els.choices.querySelectorAll('.choice').forEach((btn) => {
      const badge = btn.querySelector('.badge');
      const on = !!last && btn.dataset.move === last.human;
      if (on) {
        badge.textContent = tag[res][0];
        badge.className = 'badge show ' + tag[res][1];
      } else {
        badge.textContent = '';
        badge.className = 'badge';
      }
    });
  }

  function pctText(p) {
    return (p * 100).toFixed(0) + '%';
  }

  function renderPanel() {
    renderCompare();      // 参数面板里的档位对比/探索判定独立于分析面板，随时保持最新
    renderRandomness();   // 人类不可预测性评估在左侧游戏区，同样与面板开关无关
    if (els.panel.hidden || !state.pending) return;
    const { metaProbs, cpuMove, bestCpu, breakdown, epsilon, explore, sampled, weightSum, scores } = state.pending;

    // 预测概览（无真实依据时不显示预测）
    const hasData = breakdown.some((b) => !b.baseline && b.matched);
    if (!hasData) {
      els.forecast.innerHTML = `
        <div class="fc-head">下招预测（你）</div>
        <div class="fc-empty">暂无数据 · 先出几招，AI 才有依据</div>`;
    } else {
      const topMove = MOVES.reduce((a, b) => (metaProbs[a] >= metaProbs[b] ? a : b));
      const bars = MOVES.map((m) => {
        const isTop = m === topMove;
        return `
          <div class="fc-row${isTop ? ' top' : ''}">
            <span class="fc-name">${EMOJI[m]} ${NAMES[m]}</span>
            <span class="fc-track"><i style="width:${(metaProbs[m] * 100).toFixed(1)}%"></i></span>
            <span class="fc-val">${pctText(metaProbs[m])}</span>
          </div>`;
      }).join('');

      // 电脑三招各自的期望收益（赢概率 − 输概率），高亮收益最高的一招
      const evRows = MOVES.map((c) => {
        const s = (scores && scores[c]) || 0;
        return `<span class="fc-ev-chip${c === bestCpu ? ' on' : ''}"><i>${EMOJI[c]}</i>${s >= 0 ? '+' : ''}${s.toFixed(2)}</span>`;
      }).join('');

      const bv = (scores && scores[cpuMove]) || 0;
      const noData = weightSum === 0;
      const targetNote = noData
        ? '（随机出招）'
        : explore
          ? '（探索）'
          : sampled
            ? '（按分布取样）'
            : '';

      // 本局随机概率的提示：三项来源取最大，并指出当前是谁在起作用
      const epsTip = epsBreakdown(state.pending).tip;
      els.forecast.innerHTML = `
        <div class="fc-head">下招预测（你）</div>
        ${bars}
        ${weightSum > 0
          ? `<div class="fc-ev" title="每招的期望收益 = 该招击败你的概率 − 该招被你击败的概率，取最大者出招。"><span class="fc-ev-head">期望收益</span><div class="fc-ev-chips">${evRows}</div></div>`
          : '<div class="fc-alert">所有标准的应验率都没超过随机基准 33%，AI 暂无可信依据，本局只能随机出招。</div>'}
        <div class="fc-target" title="AI 按「期望收益最高」的一招出招。括号说明本局的特殊情况：「随机出招」= 所有标准应验率都没超过随机基准，只能随机出招；「探索」= 本局触发探索扰动，并非按期望收益所选；「按分布取样」= 预测尚未显著优于随机，改按预测分布取样。">电脑选 <b>${EMOJI[cpuMove]} ${NAMES[cpuMove]}</b>${targetNote}${noData ? '' : `，期望收益 <b>${bv >= 0 ? '+' : ''}${bv.toFixed(2)}</b>`}</div>
        <div class="fc-note" data-tip="${epsTip}">${noData ? '' : `本局随机出招概率 ${(epsilon * 100).toFixed(1)}%`}</div>
      `;
    }

    // 标准明细（默认按应验率降序；未匹配沉底；随机基线也参与排序）
    const ordered = breakdown.slice();
    if (panelSort === 'weight' || panelSort === 'acc') {
      const key = panelSort === 'weight' ? 'share' : 'accuracy';
      ordered.sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        return (b[key] || 0) - (a[key] || 0);
      });
    }
    const relName = (k) => ({ win: '胜', draw: '平', lose: '负' })[k];

    els.criteriaBody.innerHTML = ordered
      .map((item) => {
        const e = item.expert;
        const title = `<td class="c-name"><b>${e.name}</b><span class="c-desc">${e.desc}</span></td>`;

        if (item.baseline) {
          const bp = ((item.share || 0) * 100).toFixed(1);
          return `<tr class="baseline">
            ${title}
            <td class="c-key">无信息</td>
            <td class="c-counts"><span class="c-empty">各 1/3</span></td>
            <td class="c-pred">均匀随机</td>
            <td class="c-acc">33%<span class="c-tries"> / 基准</span></td>
            <td class="c-weight" title="权重占比 ${bp}%"><span class="w-track"><i style="width:${bp}%"></i></span></td>
          </tr>`;
        }

        if (!item.matched) {
          return `<tr class="dim">${title}<td colspan="5" class="c-empty">数据不足，暂不参与</td></tr>`;
        }

        const c = item.counts;
        const isRel = e.mode === 'result';
        let counts;
        let predCell;
        if (isRel) {
          const tally = { win: 0, draw: 0, lose: 0 };
          for (const m of MOVES) tally[relation(m, item.refMove)] += c[m];
          counts = ['win', 'lose', 'draw']
            .map((k) => `<span class="chip${tally[k] ? '' : ' zero'}">${relName(k)} ${Math.round(tally[k])}</span>`)
            .join('');
          const pk = relation(item.prediction, item.refMove);
          predCell = `<span class="rel ${pk}">${relName(pk)}</span>`;
        } else {
          counts = MOVES.map(
            (m) => `<span class="chip${c[m] ? '' : ' zero'}">${EMOJI[m]} ${Math.round(c[m])}</span>`
          ).join('');
          predCell = `${EMOJI[item.prediction]} ${NAMES[item.prediction]}`;
        }
        const countsTitle = isRel
          ? '在「当前依据」这个局面下，历史上你各关系（胜/负/平）出现的次数'
          : '在「当前依据」这个局面下，历史上你各招（✊/✋/✌）出现的次数';
        const keyText =
          item.key === 'ALL'
            ? '全部历史'
            : isRel
              ? item.key.split('>').map(relName).join(' → ')
              : item.key.replace(/>/g, ' → ').replace(/[RPS]/g, (s) => EMOJI[s]);
        const delta = Math.round((item.accuracy - 1 / 3) * 100);
        const accCell = item.tries
          ? `${pctText(item.accuracy)}<span class="c-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</span><span class="c-tries"> / ${Math.round(item.tries)} 次</span>`
          : '—';
        const accTitle = item.tries
          ? `应验率 ${pctText(item.accuracy)}（相对随机基准 33% 为 ${delta >= 0 ? '+' : ''}${delta} 个百分点）；共评估 ${Math.round(item.tries)} 次`
          : '';
        const sharePct = ((item.share || 0) * 100).toFixed(1);
        return `<tr>
          ${title}
          <td class="c-key">${keyText}</td>
          <td class="c-counts" title="${countsTitle}">${counts}</td>
          <td class="c-pred">${predCell}</td>
          <td class="c-acc" title="${accTitle}">${accCell}</td>
          <td class="c-weight" title="权重占比 ${sharePct}%"><span class="w-track"><i style="width:${sharePct}%"></i></span></td>
        </tr>`;
      })
      .join('');
  }

  /** 档位胜率对比：一行一个档位（标签 · 条形 · 胜率），当前档位高亮；rate 为空时留空 */
  const cmpRow = (k, rate, on) => {
    const has = rate != null;
    return `<div class="cmp-row${on ? ' on' : ''}"><span class="cmp-k">${k}</span>` +
      `<span class="cmp-track"><i style="width:${has ? (rate * 100).toFixed(0) : 0}%"></i></span>` +
      `<span class="cmp-v">${has ? (rate * 100).toFixed(0) + '%' : '\u2014'}</span></div>`;
  };
  const cmpTitle = (text, n, tip) =>
    `<div class="cmp-title"${tip ? ` title="${tip}"` : ''}>${text}${n ? `<span class="cmp-sub">最近 ${n} 局</span>` : ''}</div>`;

  /**
   * 本局纯随机出招概率（ε）的来源明细。
   * ε = max(探索强度档位, 开局随机度, 自适应扰动)，只有「探索强度档位」受上层显著性检验的上限约束。
   */
  function epsBreakdown(pd) {
    const items = [
      ['探索强度档位', Number(pd.exploreScale) || 0, true],
      ['开局随机度', Number(pd.earlyRand) || 0, false],
      ['自适应扰动', Number(pd.adaptiveEps) || 0, false],
    ];
    const top = items.reduce((a, b) => (b[1] > a[1] ? b : a));
    const tip = '本局真正采用的纯随机出招概率 = 三项取最大：'
      + items.map(([n, v, capped]) => `${n} ${(v * 100).toFixed(1)}%${capped ? '（受上限约束）' : '（不受上限约束）'}`).join('、')
      + `。当前起作用的是「${top[0]}」`
      + (top[2] ? '。' : '——它不受上限约束，所以会比参数面板里的「探索强度上限」高。');
    return { top, tip };
  }

  /** 各档位的电脑胜率对比（自动调参依据） */
  function renderCompare() {
    if (!els.confCompare) return;
    const win = state.shadow.slice(-Z_WINDOW);
    const t = state.rateTable;
    const cur = Number(els.confInput.value) || 0;
    els.confCompare.innerHTML = cmpTitle('收缩档位命中率', win.length, '预测命中率 = 该档位对下一招的预测命中你实际出招的比例（以当前半衰期为权重基准）') +
      Z_CANDIDATES.map((zz, i) => cmpRow(String(zz), t ? t[i].rate : null, Math.abs(zz - cur) < 1e-9)).join('');

    if (els.hlCompare) {
      const dwin = state.decayShadow.slice(-Z_WINDOW);
      const dt = state.decayRateTable;
      const curHl = Number(els.hlInput.value) || 0;
      els.hlCompare.innerHTML = cmpTitle('记忆半衰期命中率', dwin.length, '预测命中率 = 该档位对下一招的预测命中你实际出招的比例（各档位按自身半衰期加权）') +
        DECAY_TIERS.map((v, i) => cmpRow(v > 0 ? v + ' 局' : '不遗忘', dt ? dt[i].rate : null, v === curHl)).join('');
    }

    if (!els.exploreCompare) return;
    const st = state.exploreStat;
    const cap = st ? Math.round((state.exploreCap || 0) * 100) : null;
    const pd = state.pending;
    const epsInfo = pd ? epsBreakdown(pd) : null;
    els.exploreCompare.innerHTML =
      cmpTitle('探索上限判定', state.bestLog.slice(-Z_WINDOW).length,
        '决定电脑最多能掺多少「纯随机出招」。只有当你已经看穿它、它老老实实按预测出招反而赢不了的时候（胜率明显低于瞎猜的 33%），才会开始掺随机。'
        + '注意：这个上限只管「探索强度」这一项。下面的「本局实际随机概率」还可能被开局随机度或自适应扰动顶上去，所以会高于上限，并不矛盾。') +
      `<div class="exp-row" data-tip="最近这些局里，电脑如果每次都按预测最优的那招出，实际赢下的比例（平局不算）。约 33% 就是瞎猜的水平；明显更低，说明它的套路被你看穿了。"><span>按最优出招的胜率</span><b>${st ? (st.w * 100).toFixed(1) + '%' : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="实际参与统计的对局数（按半衰期加权后的等效数量，越近的局权重越大；平局不计入）。局数太少时结果不可靠，所以不足 12 局不做判定。"><span>有效局数</span><b>${st ? st.nEff.toFixed(1) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="上面那个差距有多可信。≤ 1 视为「没有明显差别」，此时完全不掺随机；到 3 就认为确实被针对了，上限拉满。"><span>可信程度</span><b>${st ? st.z.toFixed(2) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="自动调参能给「探索强度」档位开到的最大值（由显著性检验决定）。它只管探索强度这一项；开局随机度与自适应扰动不受它约束，所以本局实际随机概率可以比它高。"><span>探索强度上限</span><b>${cap == null ? '\u2014' : cap + '%'}</b></div>` +
      `<div class="exp-row" data-tip="${epsInfo ? epsInfo.tip : '本局尚未开始。'}"><span>本局实际随机概率</span><b>${epsInfo ? (pd.epsilon * 100).toFixed(1) + '%' : '\u2014'}</b></div>`;

    if (!els.predictCompare) return;
    const ps = state.predictStat;
    const tp = Math.round((state.predictTrust || 0) * 100);
    els.predictCompare.innerHTML =
      cmpTitle('押注判定', state.hitLog.slice(-Z_WINDOW).length,
        '决定电脑要不要「押注」自己的预测。只有预测被证明确实比瞎猜准时，它才会挑期望收益最高的那招出；否则按预测分布随机取一招，避免总出同一招被你看穿。') +
      `<div class="exp-row" data-tip="最近这些局里，电脑对你下一招的预测命中你实际出招的比例（跟它自己出什么招无关）。约 33% 就是瞎猜的水平。"><span>预测命中率</span><b>${ps ? (ps.w * 100).toFixed(1) + '%' : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="实际参与统计的对局数（按半衰期加权后的等效数量，越近的局权重越大）。局数太少时结果不可靠，所以不足 12 局不做判定。"><span>有效局数</span><b>${ps ? ps.nEff.toFixed(1) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="「预测确实比瞎猜准」这一点的可信度。≤ 1 视为没差别，此时不押注；到 3 就完全信任预测，每局都押注最优招。"><span>可信程度</span><b>${ps ? ps.z.toFixed(2) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="本局有多大概率直接押注最优招，剩下的概率按预测分布取样（出招仍偏向它认为你更可能出的那一招，只是不再固定）。"><span>押注概率</span><b>${tp}%</b></div>`;
  }

  /**
   * 人类不可预测性评估：直接套用 AI 自己的「预测命中率」当尺子。
   * 33%（随机基线）= 满分；命中率越高，说明你的出招越容易被抓住。
   */
  /**
   * AI 预测命中率（两种口径）：
   *   a = 全部统计（所有对局等权）
   *   b = 按半衰期加权（近局权重更大；halfLife = 0 不遗忘时等同 a）
   *   n = 加权有效样本量（Kish 有效样本数 (Σw)² / Σw²）
   */
  function hitStats() {
    const a = state.hitTries ? state.hit / state.hitTries : null;
    const hl = Number(predictor.options.halfLife) || 0;
    const len = state.hitLog.length;
    if (!hl || !len) return { a, b: a, n: state.hitTries };
    let sw = 0;
    let swh = 0;
    let sw2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.pow(0.5, (len - 1 - i) / hl);
      sw += w;
      sw2 += w * w;
      swh += w * state.hitLog[i];
    }
    return { a, b: sw ? swh / sw : a, n: sw2 ? (sw * sw) / sw2 : state.hitTries };
  }

  function randomnessReport() {
    // 命中率按「半衰期加权」口径（近局权重更大），与记分板里的 B 值一致
    const hs = hitStats();
    const n = hs.n;
    if (!(n >= 12)) return null;

    const hitRate = hs.b;

    // 挑「收缩后应验率」最高的标准 = 你最容易被抓的破绽（小样本会被压向 1/3，避免噪声误报）
    let best = null;
    let bestAdj = 0;
    for (const e of predictor.experts) {
      if (e.baseline || e.tries < 3) continue;
      const adj = 1 / 3 + (e.accuracy - 1 / 3) * (e.tries / (e.tries + 6));
      if (adj > bestAdj) {
        bestAdj = adj;
        best = e;
      }
    }

    const cnt = { R: 0, P: 0, S: 0 };
    for (const r of state.history) cnt[r.human]++;
    const total = state.history.length || 1;

    // 用样本量标准化：z = 预测命中率相对随机基准偏离多少个标准误
    const z = (hitRate - 1 / 3) / Math.sqrt((1 / 3) * (2 / 3) / n);
    // 评分：100 = 命中率与随机基准（1/3）持平或略低（z ∈ [-0.5, 0)）。
    // 正侧不留死区：命中率一超过 1/3 就扣分（每 1 个标准误 40 分，最低 0）；
    // 负侧要「明显低于」才加分（z < -0.5，每 1 个标准误 40 分，最高 150）。
    const score = Math.max(0, Math.round(
      z >= 0 ? 100 - 40 * z
        : z < -0.5 ? 100 + Math.min(50, (-0.5 - z) * 40)
          : 100
    ));
    return { n, hitRate, z, best, bestAdj, cnt, total, score };
  }

  /** 人类不可预测性评估（面板区块） */
  function renderRandomness() {
    if (!els.randomness) return;
    const r = randomnessReport();
    const over = !!r && r.score > 100;
    els.randomness.classList.toggle('over', over);
    els.randomness.classList.toggle('max', !!r && r.score >= 140);
    // 特效强度：前段快速抬升（刚破 100 就明显），150 分拉满
    const t = over ? Math.min(1, (r.score - 100) / 50) : 0;
    els.randomness.style.setProperty('--rand-power', (over ? 0.35 + 0.65 * Math.pow(t, 0.6) : 0).toFixed(3));
    if (!r) {
      // 未满 12 局：渲染同一套骨架（数值留空），让卡片高度与「评估出来之后」一致，避免跳变
      els.randomness.innerHTML = `
        <div class="rand-head">
          <span>人类不可预测性评估</span>
          <span class="rand-score">—</span>
        </div>
        <div class="rand-bar"><i style="width:0%"></i></div>
        <div class="rand-rows">
          <div class="rand-row">
            <span class="rand-name">AI 预测命中率</span>
            <span class="rand-val">—</span>
          </div>
          <div class="rand-cmp">
            <div class="rand-cmp-track"><i style="width:0%"></i><u style="left:33.333%"></u></div>
            <div class="rand-cmp-legend"><span class="l0">0%</span><span class="lbase">随机基准 33%</span><span class="l100">100%</span></div>
          </div>
          <div class="rand-row">
            <span class="rand-name">最大可预测优势</span>
            <span class="rand-val">—</span>
          </div>
          <div class="rand-row">
            <span class="rand-name">出招分布</span>
            <span class="rand-val dist">—</span>
          </div>
        </div>
        <div class="rand-verdict">玩满 12 局后开始评估</div>
        <div class="rand-note">样本满 12 局后开始统计：命中率按<b>半衰期加权</b>口径（近局权重更大），并与随机基准 1/3 比较。</div>`;
      return;
    }
    const verdict =
      r.score >= 140 ? 'AI 彻底崩了：它对你毫无还手之力——开挂了吧？！'
        : r.score > 110 ? 'AI 已经懵了——它的套路全被你反手用在自己身上'
          : r.score > 100 ? '像是摸到了 AI 的门道，开始反着它出招'
            : r.score >= 90 ? '与真随机无显著差异，AI 无从利用'
              : r.score >= 65 ? '存在轻微规律，AI 可部分利用'
                : r.score >= 35 ? '规律较明显，AI 已能有效利用'
                  : '规律显著，极易被针对';
    const delta = r.best ? Math.round((r.best.accuracy - 1 / 3) * 100) : 0;
    const hl = Number(predictor.options.halfLife) || 0;
    const hlNote = hl > 0 ? `（半衰期 ${hl} 局）` : '（全部统计）';
    // 与随机基准 33% 的差值（百分点）
    const diffPct = (r.hitRate - 1 / 3) * 100;
    const diffText = `${diffPct >= 0 ? '高' : '低'} ${Math.abs(diffPct).toFixed(0)}pp`;
    const bestText = r.best && r.bestAdj > 1 / 3 + 0.01
      ? `<span class="rand-best"><b>${r.best.name}</b><span class="rand-best-val">${pctText(r.best.accuracy)}（${delta >= 0 ? '+' : ''}${delta}%）</span></span>`
      : '没有明显破绽';
    els.randomness.innerHTML = `
      <div class="rand-head">
        <span>人类不可预测性评估</span>
        <span class="rand-score${over ? ' over' : ''}" title="不可预测性评分：100 = 与随机基准（命中率 1/3）持平；可超过 100（越难预测越高，最高 150）。">${r.score}<i>/100</i></span>
      </div>
      <div class="rand-bar"><i style="width:${Math.min(100, r.score)}%"></i></div>
      <div class="rand-rows">
        <div class="rand-row" title="AI 对你下一招的预测命中你实际出招的比例（与电脑实际出招无关）；此处按半衰期加权，近局权重更大（半衰期为 0 时等同全部统计）。">
          <span class="rand-name">AI 预测命中率${hlNote}</span>
          <span class="rand-val">${pctText(r.hitRate)}</span>
          <span class="rand-sub">${diffText}</span>
        </div>
        <div class="rand-cmp" title="33% 是「你完全乱出」时 AI 也能猜中的比例（随机基准）；你的命中率低于它，说明 AI 反而抓不住你。">
          <div class="rand-cmp-track"><i style="width:${(r.hitRate * 100).toFixed(1)}%"></i><u style="left:33.333%"></u></div>
          <div class="rand-cmp-legend"><span class="l0">0%</span><span class="lbase">随机基准 33%</span><span class="l100">100%</span></div>
        </div>
        <div class="rand-row" title="各「标准」里收缩后应验率最高的那一条——也就是你最容易被抓住的破绽（小样本会被压向 1/3，避免噪声误报）。">
          <span class="rand-name">最大可预测优势</span>
          <span class="rand-val">${bestText}</span>
        </div>
        <div class="rand-row" title="你全部对局里 ✊ / ✋ / ✌ 各自的出现比例（仅作直观参考）。">
          <span class="rand-name">出招分布</span>
          <span class="rand-val dist">${MOVES.map((m) => `<b>${EMOJI[m]} ${((r.cnt[m] / r.total) * 100).toFixed(0)}%</b>`).join('')}</span>
        </div>
      </div>
      <div class="rand-verdict">${verdict}</div>
      <div class="rand-note">命中率按<b>半衰期加权</b>口径（近局权重更大）：z > 0（高于 1/3）扣分、最低 0；z < −0.5（明显低于 1/3）加分、最高 150（当前 z = ${r.z.toFixed(2)}，有效样本 ${Math.round(r.n)} 局）。</div>`;
  }

  /* ------------------------------ 对局记录 ------------------------------ */

  function renderHistory() {
    const recs = state.history;
    // 色块 10px + 间隙 3px；按可用宽度决定显示多少个，避免溢出（容器不再裁剪，溢出会顶出卡片）
    const per = 13;
    const avail = els.records.clientWidth || 260;
    const maxN = Math.max(6, Math.min(24, Math.floor(avail / per)));
    const recent = recs.slice(-maxN);
    const base = recs.length - recent.length;

    els.records.innerHTML = recent
      .map((r, i) => {
        const res = judge(r.human, r.cpu);
        const label = res === 'human' ? '你赢了' : res === 'cpu' ? '电脑赢了' : '平局';
        return `<span class="rec ${res}" title="第 ${base + i + 1} 局　你 ${NAMES[r.human]} vs 电脑 ${NAMES[r.cpu]}　${label}"></span>`;
      })
      .join('');

    const last10 = recs.slice(-10);
    if (!last10.length) {
      els.historyStats.textContent = '暂无记录';
      return;
    }
    const win = last10.filter((r) => judge(r.human, r.cpu) === 'human').length;
    const lose = last10.filter((r) => judge(r.human, r.cpu) === 'cpu').length;
    const draw = last10.length - win - lose;
    els.historyStats.innerHTML = `最近 <b>${last10.length}</b> 局：你 <b>${win}</b> 胜 <b>${draw}</b> 平 <b>${lose}</b> 负`;
  }

  /* ------------------------------ NIST SP 800-22 ------------------------------ */

  /** 把出招序列编码成比特流并跑完整 15 项检验，渲染成报告 */
  function renderNist() {
    const n = state.history.length;
    if (n < 64) {
      els.nistBody.innerHTML =
        `<div class="nist-loading">样本太少（当前 ${n} 局，需要至少 <b>64</b> 局）。<br />`
        + '样本太少时几乎必然满分，没有参考价值，所以不做检测。</div>';
      return;
    }
    const bits = NIST.buildBits(state.history);
    // 零分布标定：生成同长度、同编码的真随机序列作对照
    const resample = () => {
      const h = new Array(n);
      for (let i = 0; i < n; i++) h[i] = { human: MOVES[randInt(MOVES.length)], cpu: 'R' };
      return NIST.buildBits(h);
    };
    const rows = NIST.run(bits, resample);
    const usable = rows.filter((r) => r.ok).length;
    const pass = rows.filter((r) => r.pass).length;
    const edge = rows.filter((r) => r.edge).length;
    const fail = usable - pass;
    const na = rows.length - usable;
    const score = usable ? Math.round((100 * (usable - fail - 0.5 * edge)) / usable) : 0;
    const verdict = score >= 95 ? '出招与真随机不可区分，几乎无法被预测'
      : score >= 80 ? '整体随机，个别指标有轻微偏离'
        : score >= 60 ? '有一些可读规律，AI 可能抓到一部分'
          : '规律比较明显，容易被针对';
    const smallCount = rows.filter((r) => r.ok && r.small).length;
    const pTxt = (r) => (!r.ok ? '—' : r.p < 0.0001 ? r.p.toExponential(2) : r.p.toFixed(4));
    const tag = (r) => (!r.ok
      ? '<span class="nist-tag na">样本不足</span>'
      : !r.pass ? '<span class="nist-tag bad">未通过</span>'
        : r.edge ? '<span class="nist-tag mid">边缘</span>'
          : '<span class="nist-tag ok">通过</span>');

    els.nistBody.innerHTML = `
      <div class="nist-intro">
        <p><b>在测什么？</b>测的是<b>你的出招序列有多像真随机</b>——也就是「你的手够不够随机、有多容易被 AI 抓住」。</p>
        <p>把每招按 2 比特编码成比特流（当前 <b>${bits.length}</b> 比特），再跑 NIST SP 800-22 的 <b>15 项</b>统计检验。
        每项检验都在问同一个问题：<b>这一段看起来像不像真随机</b>。全部通过 = 你的出招与真随机无法区分；
        未通过的项目，就是 AI 可能加以利用的规律。</p>
      </div>
      <div class="nist-score">
        <div class="nist-score-top"><span>人类随机性评分</span><b>${score}<i>/100</i></b></div>
        <div class="nist-score-bar"><i style="width:${score}%"></i></div>
        <div class="nist-score-txt">${verdict}<br />可测 ${usable} 项：通过 ${pass}、边缘 ${edge}、未通过 ${fail}；样本不足 ${na} 项不计分，样本越多评分越可靠</div>
      </div>
      <p class="nist-note">
        编码：<b>✊ = 00</b>、<b>✋ = 01</b>、<b>✌ = 11</b>——NIST 文档对 k 进制输入的推荐做法（每符号 ⌈log₂k⌉ = 2 比特），
        1 的比例从此类编码上就恰好均衡。判定阈值 <b>p ≥ 0.01</b>，<b>0.01 ≤ p < 0.05</b> 计为「边缘」（算半分）。
      </p>
      <p class="nist-note">
        ⚠ NIST 原本建议样本量 ≥ 10⁶ 比特（约 50 万局），现实样本远小于此。为消除样本量与「每符 2 比特」编码
        带来的系统性偏差，本报告对每项都做了<b>零分布标定</b>：额外生成 200 条同样长度、同样编码的真随机序列，
        用它们统计量的经验分布重新计算 p 值。所以表中 p 值是「相对于同条件下的真随机」而言的，不受编码伪影影响；
        「取多个模板中最差」这类多重比较也一并被自动校正。
      </p>
      <p class="nist-note">
        其中 <b>${smallCount} 项</b>会随样本量自动缩放参数（块长、矩阵阶数 2×2 ~ 32×32、模板长度 2~4 比特、通用统计的 L / Q、
        线性复杂度块长等），表中已标「小样本」；样本充足时自动回到 NIST 原版参数。再加上零分布标定
        （用同样长度、同样参数的真随机序列作对照）。样本小于 <b>64 局</b>（128 比特）时不做检测——太少的样本几乎必然满分，没有参考价值；
        样本越多，结论越稳定。
      </p>
      <div class="nist-intro">
        <p><b>p 值怎么读？</b>p 值是「<b>假如你的出招完全随机</b>，单靠运气也能出现这么极端结果的概率」。</p>
        <p>所以<b> p 越大 = 越看不出异常</b>：比如 p = 0.40，意思是「随机的话有 40% 的机会看起来比这还夸张」，完全正常；
        而 p = 0.005，意思是「随机的话只有 0.5% 的机会会这样」，小到不太像巧合，于是判为「有规律」。</p>
        <p>判定线用 NIST 惯例的 <b>0.01</b>：<b>≥ 0.01 通过</b>、<b>0.01 ~ 0.05 边缘</b>（有点可疑，但还不足以下结论）、<b>低于 0.01 未通过</b>。
        p 值不是「你随机的概率」，也不是越大越好——只要不低于 0.01，就说明这项检验没抓到问题。</p>
      </div>
      <table class="nist-table">
        <thead><tr><th>#</th><th>检验项</th><th title="该项检验算出的数值，与 p 值一一对应">统计量</th><th title="假如你的出招完全随机，也能出现这么极端结果的概率。≥ 0.01 视为通过。">p 值</th><th title="通过 = 没抓到规律；未通过 = 这项检验发现了可疑规律">判定</th></tr></thead>
        <tbody>
          ${rows
            .map((r, i) => `
            <tr class="${r.ok && !r.pass ? 'bad' : ''}">
              <td class="nist-idx">${i + 1}</td>
              <td class="nist-name"><b>${r.name}${r.small ? '<i class="nist-mini">小样本</i>' : ''}</b><span>${r.en}</span></td>
              <td class="nist-stat">${Number.isFinite(r.stat) ? r.stat.toFixed(4) : '—'}<span>${r.detail}</span></td>
              <td class="nist-p">${pTxt(r)}</td>
              <td>${tag(r)}</td>
            </tr>`)
            .join('')}
        </tbody>
      </table>`;
  }

  /* ------------------------------ 事件 ------------------------------ */

  els.choices.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.choice');
    if (btn) play(btn.dataset.move);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape' && !els.nistModal.hidden) {
      els.nistModal.hidden = true;
      return;
    }
    if (!els.nistModal.hidden) return;
    const idx = ['1', '2', '3'].indexOf(ev.key);
    if (idx >= 0) {
      ev.preventDefault();
      play(MOVES[idx]);
    }
  });

  els.resetBtn.addEventListener('click', resetAll);
  els.nistBtn.addEventListener('click', () => {
    els.nistModal.hidden = false;
    els.nistBody.innerHTML = '<div class="nist-loading">正在跑 15 项检验（累积和拆正向/反向共 16 行）+ 200 次零分布标定…</div>';
    setTimeout(renderNist, 30);
  });
  els.nistClose.addEventListener('click', () => { els.nistModal.hidden = true; });
  els.nistBackdrop.addEventListener('click', () => { els.nistModal.hidden = true; });
  els.exportBtn.addEventListener('click', exportSave);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importSave(f);
    ev.target.value = '';
  });

  els.confInput.addEventListener('input', () => {
    const v = Number(els.confInput.value);
    els.confOut.textContent = v.toFixed(1);
    predictor.options.confidence = v;
    startRound();
  });

  els.hlInput.addEventListener('input', () => {
    const v = Number(els.hlInput.value);
    els.hlOut.textContent = v > 0 ? v + ' 局' : '不遗忘';
    predictor.options.halfLife = v;
    predictor.replay(state.history);
    renderScores();
    startRound();
  });

  els.alphaInput.addEventListener('input', () => {
    const v = Number(els.alphaInput.value);
    els.alphaOut.textContent = v.toFixed(1);
    predictor.options.alpha = v;
    predictor.replay(state.history);
    startRound();
  });

  els.epsInput.addEventListener('input', () => {
    const v = Number(els.epsInput.value) / 100;
    els.epsOut.textContent = Math.round(v * 100) + '%';
    predictor.options.exploreScale = v;
    startRound();
  });

  els.exploreInput.addEventListener('change', () => {
    predictor.options.explore = els.exploreInput.checked;
    syncParamDisabled();
    startRound();
  });

  els.autoInput.addEventListener('change', () => {
    const on = els.autoInput.checked;
    syncParamDisabled();
    if (on) autoTuneStep();
    startRound();
  });

  els.paramReset.addEventListener('click', () => {
    // 恢复默认：自动调参开、探索扰动开，参数交由自动逻辑接管
    els.autoInput.checked = true;
    els.exploreInput.checked = true;
    predictor.options.explore = true;
    predictor.options.exploreScale = 0.1;
    els.epsInput.value = '10';
    els.epsOut.textContent = '10%';
    syncParamDisabled();
    autoTuneStep();
    startRound();
  });

  function togglePanel(show) {
    const open = show === undefined ? els.panel.hidden : show;
    els.panel.hidden = !open;
    els.layout.classList.toggle('with-panel', open);
    els.panelBtn.textContent = open ? '隐藏分析面板' : '显示分析面板';
    if (open) renderPanel();
  }

  els.panelBtn.addEventListener('click', () => togglePanel());
  els.panelClose.addEventListener('click', () => togglePanel(false));

  els.sortSeg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    panelSort = btn.dataset.sort;
    els.sortSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderPanel();
  });

  /* ------------------------------ 启动 ------------------------------ */

  /** 统一悬浮提示：把原生 title 转成自定义 data-tip（立即显示、样式一致） */
  function initTooltips() {
    const convert = (el) => {
      if (!el.hasAttribute || !el.hasAttribute('title')) return;
      const t = el.getAttribute('title');
      el.removeAttribute('title');
      if (t) el.setAttribute('data-tip', t);
    };
    document.querySelectorAll('[title]').forEach(convert);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') { convert(m.target); continue; }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          convert(n);
          if (n.querySelectorAll) n.querySelectorAll('[title]').forEach(convert);
        }
      }
    }).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['title'],
    });
  }

  initTooltips();
  renderScores();
  renderHistory();
  syncParamDisabled();
  rebuildDecayModels();
  autoTuneStep();
  startRound();
})();
