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
    orderInput: $('orderInput'),
    orderUp: $('orderUp'),
    orderDown: $('orderDown'),
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
    trend: $('trend'),
    historyStats: $('historyStats'),
    alphaInput: $('alphaInput'),
    alphaOut: $('alphaOut'),
    confInput: $('confInput'),
    confOut: $('confOut'),
    confCompare: $('confCompare'),
    hlInput: $('hlInput'),
    hlOut: $('hlOut'),
    hlCompare: $('hlCompare'),
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
    lastAvgAcc: null,                  // 上一局各参与标准的加权平均应验率
    streak: { side: null, count: 0 },
    lastResult: null,
    shadow: [],                        // 每局各收缩档位的影子战绩（'cpu'/'human'/'draw'，视角为电脑）
    shadowMoves: null,                 // 本局各档位分别选出的招
    rateTable: null,                   // 各档位在最近窗口的电脑胜率（供面板展示）
    decayShadow: [],                   // 每局各半衰期档位的影子战绩
    decayMoves: null,                  // 本局各半衰期档位分别选出的招
    decayRateTable: null,              // 各半衰期档位在最近窗口的电脑胜率
  };

  const readOptions = () => ({
    alpha: Number(els.alphaInput.value),
    exploreScale: Number(els.epsInput.value),
    explore: els.exploreInput.checked,
    confidence: Number(els.confInput.value),
    halfLife: Number(els.hlInput.value),
  });
  const newPredictor = (N) => new Predictor(N, readOptions());

  let predictor = newPredictor(Number(els.orderInput.value) || 3);
  let panelSort = 'weight';  // 'weight' 按权重 | 'acc' 按应验率 | 'default' 默认顺序

  // 自动调参：候选的样本收缩档位（0 = 完全按应验率加权）、评估窗口与最少样本
  const Z_CANDIDATES = [0, 0.5, 1, 1.5, 2];
  const Z_WINDOW = 40;
  const Z_MIN_SAMPLES = 12;
  // 记忆衰减档位（半衰期，局），取 2 的幂便于按对数均匀覆盖；0 = 不遗忘
  const DECAY_TIERS = [0, 64, 32, 16, 8];

  // 每个半衰期档位维护一份独立模型，同时学习同一份历史，用于比较电脑胜率
  let decayModels = [];
  function rebuildDecayModels() {
    const N = Number(els.orderInput.value) || 3;
    decayModels = DECAY_TIERS.map((hl) =>
      new Predictor(N, Object.assign(readOptions(), { halfLife: hl }))
    );
    for (const m of decayModels) m.replay(state.history);
  }

  /* ------------------------------ 流程 ------------------------------ */

  function startRound() {
    state.pending = predictor.decide(state.history);
    // 影子：同一局面下各收缩档位分别会出什么招，用于赛后比较电脑胜率（取不含探索的最优招）
    state.shadowMoves = Z_CANDIDATES.map((zz) => predictor.decide(state.history, zz).bestCpu);
    // 影子：各记忆半衰期档位（各持一份模型）在同一局面下的出招，都用当前收缩强度
    state.decayMoves = decayModels.map((m) => m.decide(state.history).bestCpu);
    if (state.pending && state.pending.avgAcc != null) state.lastAvgAcc = state.pending.avgAcc;
    state.revealed = false;
    state.revealedMove = null;
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

    // 若这局不探索（始终按最优预测出招）的胜负，用于「最优胜率」
    const idealRes = judge(move, state.pending.bestCpu);
    if (idealRes === 'cpu') state.ideal.win++;
    else if (idealRes === 'human') state.ideal.lose++;

    // 影子战绩：各收缩档位在同一局里分别出招的胜负（视角为电脑）
    if (state.shadowMoves) {
      state.shadow.push(state.shadowMoves.map((c) => judge(move, c)));
      const keep = Z_WINDOW * 3;
      if (state.shadow.length > keep) state.shadow.splice(0, state.shadow.length - keep);
    }

    // 影子战绩：各记忆半衰期档位在同一局里分别出招的胜负
    if (state.decayMoves) {
      state.decayShadow.push(state.decayMoves.map((c) => judge(move, c)));
      const keep = Z_WINDOW * 3;
      if (state.decayShadow.length > keep) state.decayShadow.splice(0, state.decayShadow.length - keep);
    }

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
    state.streak = { side: null, count: 0 };
    state.lastResult = null;
    state.shadow = [];
    state.shadowMoves = null;
    state.rateTable = null;
    state.decayShadow = [];
    state.decayMoves = null;
    state.decayRateTable = null;
    predictor = newPredictor(Number(els.orderInput.value) || 3);
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
  }

  /* ------------------------------ 存档 ------------------------------ */

  // 私有紧凑格式（单行）：
  // RPSD1|阶数|α|探索强度|探索开关|自动调参|统计数字|历史|命中记录
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
      Number(els.orderInput.value) || 3,
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
        exploreScale: parts[3] != null ? Number(parts[3]) : 1,
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
    state.streak = { side: null, count: 0 };
    state.lastResult = null;

    els.orderInput.value = String(Math.min(6, Math.max(1, (d.order | 0) || 3)));

    const opt = d.options || {};
    if (opt.alpha != null) els.alphaInput.value = String(opt.alpha);
    if (opt.exploreScale != null) els.epsInput.value = String(opt.exploreScale);
    els.exploreInput.checked = opt.explore !== false;
    els.confInput.value = String(d.confidence != null ? d.confidence : 1);
    els.hlInput.value = String(d.halfLife != null ? d.halfLife : 16);
    els.alphaOut.textContent = Number(els.alphaInput.value).toFixed(1);
    els.epsOut.textContent = Number(els.epsInput.value).toFixed(1) + '×';
    els.confOut.textContent = Number(els.confInput.value).toFixed(1);
    els.hlOut.textContent = Number(els.hlInput.value) > 0 ? Number(els.hlInput.value) + ' 局' : '不遗忘';
    els.autoInput.checked = d.autoTune !== false;

    state.shadow = [];
    state.shadowMoves = null;
    state.rateTable = null;
    state.decayShadow = [];
    state.decayMoves = null;
    state.decayRateTable = null;
    predictor = newPredictor(Number(els.orderInput.value));
    predictor.replay(state.history);
    rebuildDecayModels();

    els.alphaInput.disabled = els.autoInput.checked;
    els.confInput.disabled = els.autoInput.checked;
    els.epsInput.disabled = els.autoInput.checked;
    els.hlInput.disabled = els.autoInput.checked;

    autoTuneStep();
    renderScores();
    renderHistory();
    startRound();
  }

  function setOrder(n) {
    const N = Math.min(6, Math.max(1, n | 0 || 1));
    els.orderInput.value = String(N);
    predictor = newPredictor(N);
    predictor.replay(state.history);
    rebuildDecayModels();
    startRound();
  }

  /** 自动调参：α 随样本量降低；探索强度按「AI 被针对程度」增减 */
  function autoTuneStep() {
    if (!els.autoInput.checked) return;

    // α：对局越多越少平滑（越相信经验数据）
    const total = state.history.length;
    const alpha = Math.min(1.5, Math.max(0.3, 1.6 - total * 0.01));
    const alphaChanged = Math.abs(alpha - predictor.options.alpha) > 1e-9;
    predictor.options.alpha = alpha;
    els.alphaInput.value = alpha.toFixed(1);
    els.alphaOut.textContent = alpha.toFixed(1);

    // 探索强度：最近窗口里「你出招克制 AI 上一招」的比例偏离 1/3 时调节
    const W = 20;
    const recent = state.history.slice(-W);
    let next = predictor.options.exploreScale;
    if (recent.length >= 8) {
      let cnt = 0;
      for (let i = 1; i < recent.length; i++) {
        if (relation(recent[i].human, recent[i - 1].cpu) === 'win') cnt++;
      }
      const p = cnt / (recent.length - 1);
      if (p > 1 / 3 + 0.05) next += 0.05;          // 你在针对 AI → 多随机
      else if (p < 1 / 3 - 0.05) next -= 0.05;     // 你没在针对 → 少送分
      next = Math.min(1.5, Math.max(0, next));
      predictor.options.exploreScale = next;
      els.epsInput.value = next.toFixed(1);
      els.epsOut.textContent = next.toFixed(1) + '×';
    }

    // 样本收缩：让各档位在同一批局面下各自出招，比较「电脑胜率」决定用哪一档；
    // 从最小收缩开始挑，只有明显赢更多（>3%）才采用更大收缩，否则一路退回完全按应验率。
    let z = Number(els.confInput.value);
    const win = state.shadow.slice(-Z_WINDOW);
    if (win.length) {
      const rates = Z_CANDIDATES.map((_, i) => {
        let w = 0;
        let l = 0;
        for (const r of win) {
          if (r[i] === 'cpu') w++;
          else if (r[i] === 'human') l++;
        }
        return w + l ? w / (w + l) : 0.5;
      });
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

    // 记忆衰减：各半衰期档位（各持一份模型）比最近窗口的电脑胜率，择优（优先更长的记忆）
    let hl = Number(els.hlInput.value);
    const dwin = state.decayShadow.slice(-Z_WINDOW);
    if (dwin.length) {
      const drates = DECAY_TIERS.map((_, i) => {
        let w = 0;
        let l = 0;
        for (const r of dwin) {
          if (r[i] === 'cpu') w++;
          else if (r[i] === 'human') l++;
        }
        return w + l ? w / (w + l) : 0.5;
      });
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
    if (hs.a == null) {
      els.hitRate.textContent = '—';
      els.hitRate.title = '';
      els.hitRateWrap.title = 'AI 预测命中率：AI 按预测最优出招时命中你实际出招的比例（不含探索扰动）';
    } else {
      const a = Math.round(hs.a * 100);
      const b = hs.b == null ? a : Math.round(hs.b * 100);
      const hl = Number(predictor.options.halfLife) || 0;
      const hlText = hl > 0 ? `半衰期 ${hl} 局` : '半衰期为 0（不遗忘）';
      els.hitRate.textContent = a === b ? `${a}%` : `${a}% / ${b}%`;
      const tip = a === b
        ? `AI 预测命中率：AI 按预测最优出招时命中你实际出招的比例（不含探索）。${a}%（全部统计与按${hlText}加权一致）`
        : `AI 预测命中率：AI 按预测最优出招时命中你实际出招的比例（不含探索）。全部统计 ${a}% · 按${hlText}加权 ${b}%`;
      els.hitRate.title = tip;
      els.hitRateWrap.title = tip;
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
    if (els.panel.hidden || !state.pending) return;
    const { metaProbs, cpuMove, breakdown, epsilon, explore, weightSum, scores } = state.pending;

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

      // 电脑三招各自的期望收益（赢概率 − 输概率），实际出招高亮
      const evRows = MOVES.map((c) => {
        const s = (scores && scores[c]) || 0;
        return `<div class="fc-ev-row${c === cpuMove ? ' on' : ''}">
          <span class="fc-ev-name">${EMOJI[c]} ${NAMES[c]}</span>
          <span class="fc-ev-val">${s >= 0 ? '+' : ''}${s.toFixed(2)}</span>
        </div>`;
      }).join('');

      const bv = (scores && scores[cpuMove]) || 0;
      els.forecast.innerHTML = `
        <div class="fc-head">下招预测（你）</div>
        ${bars}
        ${weightSum > 0
          ? `<div class="fc-ev"><div class="fc-ev-head" title="每招的期望收益 = 该招击败你的概率 − 该招被你击败的概率，取最大者出招。">电脑各招期望收益 = 赢概率 − 输概率</div>${evRows}</div>`
          : '<div class="fc-alert">所有标准的应验率都没超过随机基准 33%，AI 暂无可信依据，本局只能随机出招。</div>'}
        <div class="fc-target">电脑选 <b>${EMOJI[cpuMove]} ${NAMES[cpuMove]}</b>${explore ? '（本局探索触发，并非按期望收益所选）' : ''}，期望收益 <b>${bv >= 0 ? '+' : ''}${bv.toFixed(2)}</b></div>
        <div class="fc-note" title="探索扰动 ε：本局放弃按期望收益出招、改为完全随机出招的概率。预测最大概率：AI 对你下一招预测分布中的最高概率。">探索扰动 ε = ${(epsilon * 100).toFixed(1)}% · 预测最大概率 ${pctText(Math.max(metaProbs.R, metaProbs.P, metaProbs.S))}</div>
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

    renderCompare();
    renderRandomness();
  }

  /** 各档位的电脑胜率对比（自动调参依据） */
  function renderCompare() {
    if (!els.confCompare) return;
    const win = state.shadow.slice(-Z_WINDOW);
    const t = state.rateTable;
    if (!t || !win.length) {
      els.confCompare.textContent = '收缩档位胜率对比：数据积累中…';
    } else {
      const cur = Number(els.confInput.value) || 0;
      els.confCompare.innerHTML =
        `<span class="cc-title">各档位电脑胜率（最近 ${win.length} 局）</span>` +
        t.map((r) => `<span class="cc${Math.abs(r.z - cur) < 1e-9 ? ' on' : ''}">收缩 ${r.z} → ${(r.rate * 100).toFixed(0)}%</span>`).join('');
    }

    if (!els.hlCompare) return;
    const dwin = state.decayShadow.slice(-Z_WINDOW);
    const dt = state.decayRateTable;
    if (!dt || !dwin.length) {
      els.hlCompare.textContent = '记忆衰减档位胜率对比：数据积累中…';
      return;
    }
    const curHl = Number(els.hlInput.value) || 0;
    els.hlCompare.innerHTML =
      '<span class="cc-title">各半衰期电脑胜率</span>' +
      dt.map((r) => `<span class="cc${r.hl === curHl ? ' on' : ''}">${r.hl > 0 ? r.hl + ' 局' : '不遗忘'} → ${(r.rate * 100).toFixed(0)}%</span>`).join('');
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
    els.randomness.classList.toggle('max', !!r && r.score >= 150);
    // 特效强度：前段快速抬升（刚破 100 就明显），150 分拉满
    const t = over ? Math.min(1, (r.score - 100) / 50) : 0;
    els.randomness.style.setProperty('--rand-power', (over ? 0.35 + 0.65 * Math.pow(t, 0.6) : 0).toFixed(3));
    if (!r) {
      els.randomness.innerHTML =
        '<div class="rand-head"><span>人类不可预测性评估</span></div><div class="rand-empty">玩满 12 局后开始评估</div>';
      return;
    }
    const verdict =
      r.score > 100 ? '比随机基准还难预测，AI 基本抓瞎'
        : r.score >= 90 ? '与真随机基本持平，AI 抓不到'
          : r.score >= 65 ? '略有规律，AI 只能勉强利用'
            : r.score >= 35 ? '规律较明显，AI 已经能利用'
              : '规律很明显，很容易被针对';
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
        <div class="rand-row" title="AI 按预测最优出招时命中你实际出招的比例（不含探索扰动）；此处按半衰期加权，近局权重更大（半衰期为 0 时等同全部统计）。">
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
      <div class="rand-note">${verdict} · 命中率按<b>半衰期加权</b>口径（近局权重更大）：z > 0（高于 1/3）扣分、最低 0；z < −0.5（明显低于 1/3）加分、最高 150（当前 z = ${r.z.toFixed(2)}，有效样本 ${Math.round(r.n)} 局）。</div>`;
  }

  /* ------------------------------ 对局记录 ------------------------------ */

  function renderHistory() {
    const recs = state.history;
    const recent = recs.slice(-40);
    const base = recs.length - recent.length;

    els.records.innerHTML = recent
      .map((r, i) => {
        const res = judge(r.human, r.cpu);
        const label = res === 'human' ? '你赢了' : res === 'cpu' ? '电脑赢了' : '平局';
        return `<div class="rec ${res}" title="第 ${base + i + 1} 局　你 ${NAMES[r.human]} vs 电脑 ${NAMES[r.cpu]}　${label}">
          <span class="rec-c">${EMOJI[r.cpu]}</span>
          <span class="rec-h">${EMOJI[r.human]}</span>
        </div>`;
      })
      .join('');
    els.records.scrollLeft = els.records.scrollWidth;

    els.trend.innerHTML = recs
      .slice(-30)
      .map((r) => `<i class="${judge(r.human, r.cpu)}"></i>`)
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

  els.orderUp.addEventListener('click', () => setOrder(Number(els.orderInput.value) + 1));
  els.orderDown.addEventListener('click', () => setOrder(Number(els.orderInput.value) - 1));
  els.orderInput.addEventListener('change', () => setOrder(Number(els.orderInput.value)));

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
    const v = Number(els.epsInput.value);
    els.epsOut.textContent = v.toFixed(1) + '×';
    predictor.options.exploreScale = v;
    startRound();
  });

  els.exploreInput.addEventListener('change', () => {
    predictor.options.explore = els.exploreInput.checked;
    startRound();
  });

  els.autoInput.addEventListener('change', () => {
    const on = els.autoInput.checked;
    els.alphaInput.disabled = on;
    els.confInput.disabled = on;
    els.epsInput.disabled = on;
    els.hlInput.disabled = on;
    if (on) autoTuneStep();
    startRound();
  });

  els.paramReset.addEventListener('click', () => {
    // 恢复默认：自动调参开、探索扰动开，参数交由自动逻辑接管
    els.autoInput.checked = true;
    els.exploreInput.checked = true;
    predictor.options.explore = true;
    predictor.options.exploreScale = 1;
    els.alphaInput.disabled = true;
    els.confInput.disabled = true;
    els.epsInput.disabled = true;
    els.hlInput.disabled = true;
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

  renderScores();
  renderHistory();
  els.alphaInput.disabled = els.autoInput.checked;
  els.confInput.disabled = els.autoInput.checked;
  els.epsInput.disabled = els.autoInput.checked;
  els.hlInput.disabled = els.autoInput.checked;
  rebuildDecayModels();
  autoTuneStep();
  startRound();
})();
