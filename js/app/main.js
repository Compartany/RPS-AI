/*!
 * RPS-AI · 对局流程与交互
 *
 * 开局 / 结算、模式切换、存档导入导出、事件绑定、悬浮提示与启动。
 */
(function (global) {
  'use strict';

  const App = global.RPSApp;
  const { els, state, tx, isAssist, predView } = App;
  const { MOVES, NAMES, EMOJI, judge } = global.RPS;
  const {
    renderScores, renderArena, renderPanel, renderHistory,
    autoTuneStep, syncPredictTrust, newPredictor, rebuildDecayModels,
  } = App;

  /* ============================== 出招日志（证明电脑没作弊） ============================== */

  /** 电脑选定出招时（你尚未出招）打印一条结构化日志：彩色标签 + 可展开的详情对象 */
  function logCpuMove(round, d) {
    const source = d.explore ? '探索随机' : d.sampled ? '按分布取样' : '押注最优招';
    const t = new Date();
    const hhmmss = t.toLocaleTimeString('zh-CN', { hour12: false })
      + '.' + String(t.getMilliseconds()).padStart(3, '0');
    if (isAssist()) {
      // 辅助模式：AI 不亲自下场，输出的是「建议我方出什么」；
      // 期望收益并列时两招都在建议之列（默认候选是其中随机挑的一个）
      const ties = d.bestTies && d.bestTies.length > 1 ? d.bestTies : null;
      const brief = (ties || [d.bestCpu]).map((m) => `${EMOJI[m]} ${NAMES[m]}(${m})`).join(' / ');
      console.log(
        `%cRPS%c 第 ${round} 局 建议 %c${brief}%c  ·  军师建议  ·  ${hhmmss}`,
        'background:#12b886;color:#fff;border-radius:4px;padding:1px 5px;font-weight:700',
        'color:#a6afc9',
        'color:#63e6be;font-weight:700',
        null,
        {
          局号: round,
          建议我方出: (ties || [d.bestCpu]).map((m) => `${NAMES[m]}(${m})`).join(' / '),
          预测对手出: `${NAMES[d.target]}(${d.target})`,
          预测最大概率: Math.max(d.metaProbs.R, d.metaProbs.P, d.metaProbs.S),
          时间戳: t.toISOString(),
        }
      );
      return;
    }
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

  /* ============================== 流程 ============================== */

  function startRound() {
    syncPredictTrust();
    const view = predView();
    state.pending = App.predictor.decide(view);
    // 影子：各收缩档位在同一局面下的「预测招」，用于赛后比较预测命中率（不含探索）
    state.shadowTargets = App.Z_CANDIDATES.map((zz) => App.predictor.decide(view, zz).target);
    // 影子：各记忆半衰期档位（各持一份模型）在同一局面下的「预测招」
    state.decayTargets = App.decayModels.map((m) => m.decide(view).target);
    if (state.pending && state.pending.avgAcc != null) state.lastAvgAcc = state.pending.avgAcc;
    state.revealed = false;
    state.revealedMove = null;
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    logCpuMove(state.history.length + 1, state.pending);   // 出招已定，立刻打日志（你还没出招）
    renderArena();
    renderPanel();
  }

  /** 对战模式：你出招（电脑的招已由 AI 定好） */
  function play(move) {
    if (state.revealed) startRound();   // 展示期间再次出招 → 立即开新局，不丢输入
    settle(move, state.pending.cpuMove);
  }

  /** 辅助模式：补录对手（真人）的实际出招，随即结算 */
  function commitRound() {
    const opp = state.picks.opp;
    if (!opp || state.revealed || !state.pending) return;
    // 我方本轮的招：默认用 AI 推荐，改选过就按改选的出
    settle(state.picks.me || state.pending.bestCpu, opp);
  }

  /**
   * 结算一局。
   * @param myMove  我方（对战模式下即「你」）的实际出招
   * @param oppMove 对手的实际出招（对战模式 = AI 已定的招；辅助模式 = 录入的真人出招）
   */
  function settle(myMove, oppMove) {
    // 被预测者的实际出招：对战模式预测你，辅助模式预测电脑（真人）
    const predicted = isAssist() ? oppMove : myMove;
    const result = judge(myMove, oppMove);

    state.revealed = true;
    state.revealedMove = myMove;
    state.revealedOpp = oppMove;
    state.lastResult = result;
    state.stats[result]++;

    state.hitTries++;
    const hitThisRound = state.pending.target === predicted;
    if (hitThisRound) state.hit++;
    state.hitLog.push(hitThisRound ? 1 : 0);
    if (state.hitLog.length > 5000) state.hitLog.splice(0, state.hitLog.length - 5000);

    // 若这局不探索（始终按最优预测出招）的胜负，用于「最优胜率」与探索上限估计。
    // 「按最优出招」的一方总是 AI：对战模式下它是电脑（bestCpu），辅助模式下是我方照 bestCpu 出。
    // 所以判定要跟着被预测者换边；结果统一记成「按最优出招的一方」视角：cpu = 它赢、human = 它输。
    const idealRes = isAssist()
      ? judge(state.pending.bestCpu, oppMove)   // 辅助：我方（最优招）vs 真人对手的实际出招
      : judge(myMove, state.pending.bestCpu);   // 对战：你的实际出招 vs 电脑的最优招
    const bestWon = isAssist() ? idealRes === 'human' : idealRes === 'cpu';
    const bestLost = isAssist() ? idealRes === 'cpu' : idealRes === 'human';
    if (bestWon) state.ideal.win++;
    else if (bestLost) state.ideal.lose++;
    state.bestLog.push(bestWon ? 'cpu' : bestLost ? 'human' : 'draw');
    if (state.bestLog.length > App.Z_WINDOW * 3) state.bestLog.splice(0, state.bestLog.length - App.Z_WINDOW * 3);

    // 影子战绩：各收缩档位的预测是否命中被预测者的实际出招
    if (state.shadowTargets) {
      state.shadow.push(state.shadowTargets.map((t) => (t === predicted ? 1 : 0)));
      const keep = App.Z_WINDOW * 3;
      if (state.shadow.length > keep) state.shadow.splice(0, state.shadow.length - keep);
    }

    // 影子战绩：各记忆半衰期档位的预测是否命中被预测者的实际出招
    if (state.decayTargets) {
      state.decayShadow.push(state.decayTargets.map((t) => (t === predicted ? 1 : 0)));
      const keep = App.Z_WINDOW * 3;
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

    const view = predView();
    App.predictor.learn(view, predicted);
    for (const m of App.decayModels) m.learn(view, predicted);
    state.history.push({ human: myMove, cpu: oppMove });

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
    App.parked[state.mode] = null;      // 只重置当前玩法这一套，另一玩法的数据原样保留
    Object.assign(state, App.emptyProfile());
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    App.predictor = newPredictor(App.ORDER);
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
  }

  /* ============================== 存档 ============================== */

  function exportSave() {
    const blob = new Blob([App.buildSave()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rps-${state.mode}-${new Date().toISOString().slice(0, 10)}.rps`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importSave(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applySave(App.parseSave(reader.result));
      } catch (err) {
        alert('存档导入失败：' + err.message);
      }
    };
    reader.onerror = () => alert('存档读取失败');
    reader.readAsText(file);
  }

  function applySave(d) {
    if (!d || !d.profiles) throw new Error('格式不正确（缺少数据段）');

    // 两套各自就位：目标模式那套搬进工作区，另一套留在寄存位备用
    App.parked.duel = d.profiles.duel || null;
    App.parked.assist = d.profiles.assist || null;
    state.mode = d.mode === 'assist' ? 'assist' : 'duel';
    App.takeProfile(state.mode);
    state.revealed = false;
    state.revealedMove = null;
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    state.pending = null;

    syncModeUI();
    App.predictor = newPredictor(App.ORDER);
    App.predictor.replay(predView());
    rebuildDecayModels();

    autoTuneStep();
    renderScores();
    renderHistory();
    startRound();
  }

  /* ============================== 模式切换 ============================== */

  /**
   * 静态文案按模式切换：元素带 data-raw（文本）/ data-raw-tip（提示）时，
   * 以该属性为「未交换过的原文」写入当前模式下的文案 —— 原文只存一份，反复调用安全。
   */
  function applyTerms() {
    document.querySelectorAll('[data-raw]').forEach((el) => {
      el.textContent = tx(el.dataset.raw);
    });
    document.querySelectorAll('[data-raw-tip]').forEach((el) => {
      el.setAttribute('data-tip', tx(el.dataset.rawTip));
      el.removeAttribute('title');
    });
  }

  /** 把当前模式反映到界面：按钮文案、录入区显隐、全部称谓 */
  function syncModeUI() {
    els.arena.dataset.mode = state.mode;
    els.modeName.textContent = App.MODE_LABEL[state.mode];
    els.cpuPick.hidden = !isAssist();
    // 「我方 / 对手」的称谓不走互换（互换针对的是「被预测者 / cpu 侧」），直接按模式写
    els.oppAvatar.textContent = isAssist() ? '对手' : 'AI';
    els.cpuLabel.textContent = `${App.oppName()}胜率`;
    els.oppPickLabel.textContent = `${App.oppName()}出了`;
    // 小格（上一轮对面的出招）的提示由 renderLast() 按当轮数据写，这里不再写死：
    // 两种模式下看的是不同的人（对战看电脑、辅助看真人对手），但措辞跟着 oppName() 走
    els.meAvatar.textContent = App.meName();
    // 辅助模式下两侧都去掉「的」，与「对手胜率」保持句式一致
    els.humanLabel.textContent = isAssist() ? '我方胜率' : '你的胜率';
    els.modeBtn.setAttribute('data-tip', isAssist()
      ? 'AI 替你出招（点击切换到对战模式）'
      : '你 vs AI（点击切换到辅助模式）');
    applyTerms();
    togglePanel(isAssist());   // 面板默认状态：辅助模式展开（要边出边看预测依据），对战模式收起
  }

  /** 切换玩法：两种模式的数据与参数各自独立 —— 切走先寄存、切回原样取回 */
  function setMode(mode) {
    if (mode === state.mode) return;
    App.parkProfile();             // 当前这套先寄好
    state.mode = mode;
    App.takeProfile(mode);         // 目标那套取回来（首次进入 = 干净的一份 + 默认参数）
    state.revealed = false;
    state.revealedMove = null;
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    state.pending = null;
    syncModeUI();
    App.predictor = newPredictor(App.ORDER);
    App.predictor.replay(predView());
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
  }

  function togglePanel(show) {
    const open = show === undefined ? els.panel.hidden : show;
    els.panel.hidden = !open;
    els.layout.classList.toggle('with-panel', open);
    els.panelBtn.textContent = open ? '隐藏分析面板' : '显示分析面板';
    if (open) renderPanel();
  }

  /* ============================== 事件 ============================== */

  /** 辅助模式：补录对手（真人）的实际出招 —— 录完立刻结算 */
  function pickOpp(move) {
    if (state.revealed || !isAssist()) return;
    state.picks.opp = move;
    commitRound();
  }

  /** 辅助模式：改选我方本轮的出招（不改就按 AI 推荐出） */
  function chooseMyMove(move) {
    if (state.revealed || !isAssist()) return;
    state.picks.me = move;
    renderArena();
  }

  els.choices.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.choice');
    if (!btn) return;
    // 辅助模式：三颗按钮是「我方出什么」，可以不听 AI 的改选
    if (isAssist()) chooseMyMove(btn.dataset.move);
    else play(btn.dataset.move);
  });

  els.cpuPick.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.pick');
    if (btn) pickOpp(btn.dataset.move);
  });

  els.modeBtn.addEventListener('click', () => setMode(isAssist() ? 'duel' : 'assist'));

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
      if (isAssist()) pickOpp(MOVES[idx]);   // 辅助模式：数字键补录「对手」的招
      else play(MOVES[idx]);
    }
  });

  els.resetBtn.addEventListener('click', resetAll);
  els.nistBtn.addEventListener('click', () => {
    els.nistModal.hidden = false;
    els.nistBody.innerHTML = '<div class="nist-loading">正在跑 15 项检验（累积和拆正向/反向共 16 行）+ 200 次零分布标定…</div>';
    setTimeout(App.renderNist, 30);
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
    App.predictor.options.confidence = v;
    startRound();
  });

  els.hlInput.addEventListener('input', () => {
    const v = Number(els.hlInput.value);
    els.hlOut.textContent = v > 0 ? v + ' 局' : '不遗忘';
    App.predictor.options.halfLife = v;
    App.predictor.replay(predView());
    renderScores();
    startRound();
  });

  els.alphaInput.addEventListener('input', () => {
    const v = Number(els.alphaInput.value);
    els.alphaOut.textContent = v.toFixed(1);
    App.predictor.options.alpha = v;
    App.predictor.replay(predView());
    startRound();
  });

  els.epsInput.addEventListener('input', () => {
    const v = Number(els.epsInput.value) / 100;
    els.epsOut.textContent = Math.round(v * 100) + '%';
    App.predictor.options.exploreScale = v;
    startRound();
  });

  els.exploreInput.addEventListener('change', () => {
    App.predictor.options.explore = els.exploreInput.checked;
    App.syncParamDisabled();
    startRound();
  });

  els.autoInput.addEventListener('change', () => {
    const on = els.autoInput.checked;
    App.syncParamDisabled();
    if (on) autoTuneStep();
    startRound();
  });

  els.paramReset.addEventListener('click', () => {
    // 恢复默认：自动调参开、探索扰动开，参数交由自动逻辑接管
    els.autoInput.checked = true;
    els.exploreInput.checked = true;
    App.predictor.options.explore = true;
    App.predictor.options.exploreScale = 0.1;
    els.epsInput.value = '10';
    els.epsOut.textContent = '10%';
    App.syncParamDisabled();
    autoTuneStep();
    startRound();
  });

  els.panelBtn.addEventListener('click', () => togglePanel());
  els.panelClose.addEventListener('click', () => togglePanel(false));

  els.sortSeg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    App.panelSort = btn.dataset.sort;
    els.sortSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderPanel();
  });

  /* ============================== 悬浮提示 ============================== */

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

  /**
   * 策略参数栏是 overflow:auto 的滚动容器，栏内提示若用 CSS 伪元素会被容器裁掉
   * （长文案直接切边）。这里改用 body 级 fixed 浮层：位置按目标元素算，并夹在视口内。
   */
  function initOverflowTips() {
    const layer = document.createElement('div');
    layer.className = 'tip-layer';
    layer.hidden = true;
    document.body.appendChild(layer);

    let current = null;

    /** 默认挂在目标下方；下方放不下就翻到上方，左右夹在视口内 */
    function show(el) {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      layer.textContent = text;
      layer.hidden = false;
      const r = el.getBoundingClientRect();
      const box = layer.getBoundingClientRect();
      const pad = 10;
      const maxLeft = Math.max(pad, window.innerWidth - box.width - pad);
      let top = r.bottom + 6;
      if (top + box.height > window.innerHeight - pad) {
        top = Math.max(pad, r.top - 6 - box.height);
      }
      layer.style.left = `${Math.min(Math.max(r.left, pad), maxLeft)}px`;
      layer.style.top = `${top}px`;
    }

    function hide() {
      current = null;
      layer.hidden = true;
    }

    document.addEventListener('mouseover', (ev) => {
      const el = ev.target.closest ? ev.target.closest('#params [data-tip]') : null;
      if (!el) { if (current) hide(); return; }
      if (el === current) return;
      current = el;
      show(el);
    });
    document.addEventListener('mouseout', (ev) => {
      if (!current) return;
      // 目标内部子元素之间移动不算离开
      if (ev.relatedTarget && current.contains(ev.relatedTarget)) return;
      const el = ev.target.closest ? ev.target.closest('#params [data-tip]') : null;
      if (el !== current) return;
      hide();
    });
    // 目标会随容器滚动 / 窗口缩放移动，跟着重算位置（而不是直接收起）
    window.addEventListener('scroll', () => { if (current) show(current); }, true);
    window.addEventListener('resize', () => { if (current) show(current); });
  }

  /* ============================== 启动 ============================== */

  initTooltips();
  initOverflowTips();
  syncModeUI();
  renderScores();
  renderHistory();
  App.syncParamDisabled();
  rebuildDecayModels();
  autoTuneStep();
  startRound();
})(window);
