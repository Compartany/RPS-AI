/*!
 * RPS-Duel · 界面与流程
 */
(function () {
  'use strict';

  const { MOVES, NAMES, EMOJI, COUNTER, Predictor, judge } = window.RPS;

  const $ = (id) => document.getElementById(id);
  const els = {
    layout: $('layout'),
    panel: $('panel'),
    panelBtn: $('panelBtn'),
    panelClose: $('panelClose'),
    orderInput: $('orderInput'),
    orderUp: $('orderUp'),
    orderDown: $('orderDown'),
    resetBtn: $('resetBtn'),
    choices: $('choices'),
    cpuMove: $('cpuMove'),
    cpuTag: $('cpuTag'),
    humanTag: $('humanTag'),
    resultBanner: $('resultBanner'),
    cpuRate: $('cpuRate'),
    drawRate: $('drawRate'),
    humanRate: $('humanRate'),
    barCpu: $('barCpu'),
    barDraw: $('barDraw'),
    barHuman: $('barHuman'),
    totalRounds: $('totalRounds'),
    streak: $('streak'),
    hitRate: $('hitRate'),
    forecast: $('forecast'),
    criteriaBody: $('criteriaBody'),
    lastCpuMove: $('lastCpuMove'),
    records: $('records'),
    trend: $('trend'),
    historyStats: $('historyStats'),
    alphaInput: $('alphaInput'),
    alphaOut: $('alphaOut'),
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
    streak: { side: null, count: 0 },
    lastResult: null,
  };

  const readOptions = () => ({
    alpha: Number(els.alphaInput.value),
    exploreScale: Number(els.epsInput.value),
    explore: els.exploreInput.checked,
  });
  const newPredictor = (N) => new Predictor(N, readOptions());

  let predictor = newPredictor(Number(els.orderInput.value) || 3);

  /* ------------------------------ 流程 ------------------------------ */

  function startRound() {
    state.pending = predictor.decide(state.history);
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
    if (state.pending.target === move) state.hit++;

    if (result === 'draw') {
      state.streak = { side: null, count: 0 };
    } else if (state.streak.side === result) {
      state.streak.count++;
    } else {
      state.streak = { side: result, count: 1 };
    }

    predictor.learn(state.history, move);
    state.history.push({ human: move, cpu });

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
    state.streak = { side: null, count: 0 };
    state.lastResult = null;
    predictor = newPredictor(Number(els.orderInput.value) || 3);
    renderScores();
    renderHistory();
    startRound();
  }

  function setOrder(n) {
    const N = Math.min(6, Math.max(1, n | 0 || 1));
    els.orderInput.value = String(N);
    predictor = newPredictor(N);
    predictor.replay(state.history);
    startRound();
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderScores() {
    const total = state.stats.cpu + state.stats.human + state.stats.draw;
    const pct = (v) => (total ? (v / total) * 100 : 0);

    const c = pct(state.stats.cpu);
    const d = pct(state.stats.draw);
    const h = pct(state.stats.human);

    els.cpuRate.textContent = `${c.toFixed(0)}%`;
    els.drawRate.textContent = `${d.toFixed(0)}%`;
    els.humanRate.textContent = `${h.toFixed(0)}%`;

    els.barCpu.style.width = `${c}%`;
    els.barDraw.style.width = `${d}%`;
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

    els.hitRate.textContent = state.hitTries
      ? `${((state.hit / state.hitTries) * 100).toFixed(0)}%`
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
    const { probs, metaProbs, target, breakdown, epsilon, explore } = state.pending;

    // 预测概览
    const bars = MOVES.map((m) => {
      const isTop = m === target;
      return `
        <div class="fc-row${isTop ? ' top' : ''}">
          <span class="fc-name">${EMOJI[m]} ${NAMES[m]}</span>
          <span class="fc-track"><i style="width:${(probs[m] * 100).toFixed(1)}%"></i></span>
          <span class="fc-val">${pctText(probs[m])}</span>
        </div>`;
    }).join('');

    els.forecast.innerHTML = `
      <div class="fc-head">下招预测（你）</div>
      ${bars}
      <div class="fc-target">AI 判断你最可能出 <b>${NAMES[target]}</b>，电脑应招 <b>${EMOJI[COUNTER[target]]} ${NAMES[COUNTER[target]]}</b></div>
      <div class="fc-note">探索扰动 ε = ${(epsilon * 100).toFixed(1)}%${explore ? '（本局已触发）' : ''} · 合成前最大概率 ${pctText(Math.max(metaProbs.R, metaProbs.P, metaProbs.S))}</div>
    `;

    // 标准明细
    els.criteriaBody.innerHTML = breakdown
      .map((item) => {
        const e = item.expert;
        const title = `<td class="c-name"><b>${e.name}</b><span class="c-desc">${e.desc}</span></td>`;
        if (!item.matched) {
          return `<tr class="dim">${title}<td colspan="5" class="c-empty">数据不足，暂不参与</td></tr>`;
        }
        const c = item.counts;
        const counts = MOVES.map(
          (m) => `<span class="chip${c[m] ? '' : ' zero'}">${EMOJI[m]} ${c[m]}</span>`
        ).join('');
        const w = Math.min(1, item.weight / 0.8);
        const keyText =
          item.key === 'ALL'
            ? '全部历史'
            : item.key.replace(/>/g, ' → ').replace(/[RPS]/g, (s) => EMOJI[s]);
        return `<tr>
          ${title}
          <td class="c-key">${keyText}</td>
          <td class="c-counts">${counts}</td>
          <td class="c-pred">${EMOJI[item.prediction]} ${NAMES[item.prediction]}</td>
          <td class="c-acc">${item.tries ? pctText(item.accuracy) : '—'}<span class="c-tries">${item.tries ? ` / ${item.tries} 次` : ''}</span></td>
          <td class="c-weight"><span class="w-track"><i style="width:${(w * 100).toFixed(0)}%"></i></span></td>
        </tr>`;
      })
      .join('');
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

  /* ------------------------------ 事件 ------------------------------ */

  els.choices.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.choice');
    if (btn) play(btn.dataset.move);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
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

  function togglePanel(show) {
    const open = show === undefined ? els.panel.hidden : show;
    els.panel.hidden = !open;
    els.layout.classList.toggle('with-panel', open);
    els.panelBtn.textContent = open ? '隐藏分析面板' : '显示分析面板';
    if (open) renderPanel();
  }

  els.panelBtn.addEventListener('click', () => togglePanel());
  els.panelClose.addEventListener('click', () => togglePanel(false));

  /* ------------------------------ 启动 ------------------------------ */

  renderScores();
  renderHistory();
  startRound();
})();
