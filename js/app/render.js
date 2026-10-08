/*!
 * RPS-AI · 界面渲染
 *
 * 记分板 / 对战区 / 分析面板 / 不可预测性卡片 / 对局记录 / NIST 报告。
 * 全部为「读状态 → 写 DOM」的纯渲染，不含业务规则。
 */
(function (global) {
  'use strict';

  const App = global.RPSApp;
  const { els, state, tx, isAssist, meName, oppName } = App;
  const { MOVES, NAMES, EMOJI, COUNTER, VICTIM, judge, relation, randInt } = global.RPS;
  const NIST = global.RPS_NIST;

  const pctText = (p) => (p * 100).toFixed(0) + '%';

  /* ============================== 记分板 ============================== */

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
      const who = state.streak.side === 'human' ? meName() : oppName();
      els.streak.textContent = `${who} ${state.streak.count} 连胜`;
      els.streak.className = 'b-' + state.streak.side;
    } else {
      els.streak.textContent = '—';
      els.streak.className = '';
    }

    const hs = App.hitStats();
    // 提示只挂在整条（#hitRateWrap）上；#hitRate 上残留的 data-tip 要清掉，否则会弹出两条
    els.hitRate.removeAttribute('data-tip');
    els.hitRate.removeAttribute('title');
    // 样本不足（连显著性检验都做不了）时只显示占位 —— 这时的命中率只是噪声，显示数字会误导
    if (hs.a == null || !(hs.n >= App.Z_MIN_SAMPLES)) {
      els.hitRate.textContent = '—';
      els.hitRateWrap.title = tx(`AI 预测命中率：AI 对人类下一招的预测命中人类实际出招的比例（与电脑实际出招无关）。样本满 ${App.Z_MIN_SAMPLES} 局后开始统计。开局十余局内各标准尚未积累出有效依据，预测与随机猜测无异，命中率接近 33% 属正常现象。`);
    } else {
      const a = Math.round(hs.a * 100);
      const b = Math.round((hs.b == null ? hs.a : hs.b) * 100);
      const hl = Number(App.predictor.options.halfLife) || 16;
      const hlText = `半衰期 ${hl} 局`;
      els.hitRate.textContent = `${b}%`;
      els.hitRateWrap.title = tx('AI 预测命中率：AI 对人类下一招的预测命中人类实际出招的比例（与电脑实际出招无关）。'
        + `显示值按${hlText}加权（${b}%），全部统计为 ${a}%。`
        + '开局阶段各标准尚未形成有效依据，数值接近随机基准 33% 属正常现象。');
    }

    // 最优胜率同理：非平局局数不足时只显示占位（比例本身还没意义）
    const idealTotal = state.ideal.win + state.ideal.lose;
    els.idealRate.textContent = idealTotal >= App.Z_MIN_SAMPLES
      ? `${((state.ideal.win / idealTotal) * 100).toFixed(0)}%`
      : '—';
  }

  /* ============================== 对战区 ============================== */

  function renderArena() {
    const pending = state.pending;
    const assist = isAssist();
    // 对手的招：揭示后看本局实际出招，否则看辅助模式里已补录的那一招
    const oppShown = state.revealed ? state.revealedOpp : (assist ? state.picks.opp : null);
    // 我方的招：辅助模式下默认照 AI 推荐（bestCpu），玩家可以在下方三颗按钮上改选；
    // 对战模式下等玩家点。即使暂时没有可信依据也必须给出确定的一招 —— 我方就是照它出的。
    // 期望收益并列最高时（pending.bestTies）这几招都算「AI 推荐」；默认候选是其中随机的一个
    const advisedTies = assist && !state.revealed && pending.weightSum > 0
      ? (pending.bestTies && pending.bestTies.length ? pending.bestTies : [pending.bestCpu])
      : [];
    const myShown = state.revealed
      ? state.revealedMove
      : assist
        ? (state.picks.me || pending.bestCpu)
        : null;

    // ---- 对手（电脑）一侧 ----
    if (state.revealed) {
      els.cpuMove.innerHTML = `<span class="glyph" data-move="${state.revealedOpp}">${EMOJI[state.revealedOpp]}</span>`;
      els.cpuMove.className = 'move-slot reveal';
      els.cpuTag.textContent = `出招：${EMOJI[state.revealedOpp]} ${NAMES[state.revealedOpp]}`;
    } else if (assist) {
      // 辅助模式：对手的招靠事后补录，没录就还是问号
      els.cpuMove.innerHTML = oppShown
        ? `<span class="glyph" data-move="${oppShown}">${EMOJI[oppShown]}</span>`
        : '<span class="glyph unknown">?</span>';
      els.cpuMove.className = 'move-slot';
      els.cpuTag.textContent = '等对手出招后补录';
    } else {
      els.cpuMove.innerHTML = '<span class="glyph unknown">?</span>';
      els.cpuMove.className = 'move-slot';
      els.cpuTag.textContent = '已出招 · 待揭示';
    }
    els.cpuTag.title = '按 F12 打开控制台可查看每局记录（出招、决策来源、预测与时间戳等）。';

    // ---- 我方一侧 ----
    // 辅助模式下也能点（可以不听 AI 的改选），但揭示后统一锁住
    els.choices.classList.toggle('locked', state.revealed);
    els.choices.querySelectorAll('.choice').forEach((btn) => {
      const mv = btn.dataset.move;
      const picked = !!myShown && mv === myShown;
      const isAdvised = advisedTies.includes(mv);
      btn.classList.toggle('picked', picked);
      // 酷炫特效固定挂在「AI 推荐」那一招上（并列时几颗都挂），不随改选而移动；无依据时不算推荐，因而不显示
      btn.classList.toggle('advised', isAdvised);
      // 与「分析面板 → AI 决策 → 期望收益」同口径同格式（赢概率 − 输概率）
      const hasScores = !!(assist && pending && pending.scores && pending.weightSum > 0);
      const sc = hasScores ? pending.scores[mv] : null;
      // 右上角角标：玩家主动点过（picks.me 有值）才挂。
      // 并列最优时几颗按钮长得一模一样，玩家分不出哪颗是「默认候选」，
      // 所以这时候点哪颗都算「选中」，一律标出来（含默认候选那颗）——
      // 否则会出现「点了另一颗同样推荐的招却没半点反应」的怪现象。
      // 其余情况只有真的改选（偏离默认候选）才标，标的是相对默认候选的收益差。
      // 没有可信依据（AI 随机出招、算不出收益）时干脆不标：那时连「推荐」都不存在，
      // 挂个角标反而是噪音。
      const altered = assist && !state.revealed && picked && !!state.picks.me && hasScores
        && (advisedTies.length > 1 || state.picks.me !== pending.bestCpu);
      if (altered) {
        const best = pending.scores[pending.bestCpu];
        // 用界面上已经显示的那两个数（都是两位小数）相减，角标才跟 .ev 对得上：
        // 例如 .ev 写着 +0.30 与 −0.30，人一眼心算的差是 −0.60，就不该出现 −0.61。
        const r2 = (v) => Math.round(v * 100) / 100;
        const gap = r2(r2(sc) - r2(best));
        btn.setAttribute('data-tag', gap === 0 ? '选中' : `${gap > 0 ? '+' : ''}${gap.toFixed(2)}`);
      } else {
        btn.removeAttribute('data-tag');
      }
      btn.classList.toggle('altered', altered);
      // 辅助模式：按钮下方标出「按当前预测的理论收益」（胜 +1 / 负 -1 的期望值，predictor 已算好）
      const evEl = btn.querySelector('.ev');
      if (!evEl) return;
      if (sc == null) { evEl.textContent = '—'; evEl.className = 'ev'; return; }
      evEl.textContent = `${sc >= 0 ? '+' : ''}${sc.toFixed(2)}`;
      evEl.className = 'ev' + (sc > 0 ? ' up' : sc < 0 ? ' down' : '');
    });
    els.humanTag.textContent = state.revealed
      ? `出招：${EMOJI[state.revealedMove]} ${NAMES[state.revealedMove]}`
      : assist
        ? assistEvidence(pending)
        : '请出招';
    // 辅助模式下这个标签讲的是「AI 凭什么这么出」，鼠标悬停给出口径说明
    if (assist) {
      els.humanTag.setAttribute('title',
        `AI 取「期望收益最高」（赢面 − 输面）的一招出，标签列出它据以判断的${oppName()}出招概率。`
        + '多数时候它就是克制最高概率项的那招，所以只列一项；若多列了一项，'
        + '说明出最高项本身比克制它更划算。若两招期望收益完全相同，则并列给出，'
        + '默认候选在两者间随机。下方三颗按钮可以改选我方出招，不改就按 AI 推荐出。');
    } else {
      els.humanTag.removeAttribute('title');
      els.humanTag.removeAttribute('data-tip');
    }

    // ---- 对手出招补录按钮（仅辅助模式） ----
    els.cpuPick.querySelectorAll('.pick').forEach((btn) => {
      btn.classList.toggle('on', !!oppShown && btn.dataset.move === oppShown);
    });

    // ---- 中缝横幅 ----
    if (state.revealed) {
      const map = {
        human: [`${meName()}赢了`, 'win'],
        cpu: [`${oppName()}赢了`, 'lose'],
        draw: ['平局', 'draw'],
      };
      els.resultBanner.textContent = map[state.lastResult][0];
      els.resultBanner.className = 'result-banner ' + map[state.lastResult][1];
    } else if (assist) {
      // 还没出结果：先给一句可操作的提示（我方本轮的出招已由下方按钮高亮表达），
      // 等记录完对手出招再变成结果
      els.resultBanner.textContent = '记录对手出招';
      els.resultBanner.className = 'result-banner';
    } else {
      els.resultBanner.textContent = '请选择出招';
      els.resultBanner.className = 'result-banner';
    }

    renderLast();
  }

  /**
   * 辅助模式：我方标签上那句「AI 决策依据」——只列数据，不做解释，读者自己意会。
   *
   * AI 取的是「期望收益最高」（赢面 − 输面）的那一招，不是简单地「克制最高概率项」。
   * 多数时候两者一致，那就只列对手最可能出的那一招，读者自会补上「所以出克制的那个」；
   * 但偶尔出最高项本身更划算（高概率项会反过来吃掉克制招），此时必须把建议招
   * 要吃下的那一项也列出来 —— 否则读者按前者推出来的结论会和 AI 正好相反。
   */
  function assistEvidence(pd) {
    if (!pd || pd.weightSum === 0) return '暂无可信依据';
    const p = pd.metaProbs;
    // 并列最优：光列对手概率推不出「两招都行」，直接把建议集与共同期望收益摆出来
    const ties = pd.bestTies && pd.bestTies.length > 1 ? pd.bestTies : null;
    if (ties) {
      const list = ties.map((m) => `${EMOJI[m]} ${NAMES[m]}`).join(' / ');
      const sc = pd.scores[ties[0]];
      return `建议${meName()}出 ${list}，期望收益 ${sc >= 0 ? '+' : ''}${sc.toFixed(2)}`;
    }
    const top = pd.target;                    // AI 预测对手最可能出的招
    const head = `${EMOJI[top]} ${NAMES[top]} ${pctText(p[top])}`;
    if (pd.bestCpu === COUNTER[top]) return `预测${oppName()} ${head}`;
    const eaten = VICTIM[pd.bestCpu];         // 建议出招能克制的对象
    return `预测${oppName()} ${head}、${EMOJI[eaten]} ${NAMES[eaten]} ${pctText(p[eaten])}`;
  }

  function renderLast() {
    const last = state.history[state.history.length - 1];

    // 本局结果的统一口径（角标与悬浮提示共用）：角标上只写短的「赢 / 平 / 输」，
    // 「谁赢了 / 谁输了」写进提示 —— 两侧各按自己的视角算（辅助模式是「我方 / 对手」，
    // 对战模式是「你 / 电脑」），否则我方那侧的「赢」放到对手按钮上会被读成「对手赢」。
    const res = last ? judge(last.human, last.cpu) : null;
    const word = { win: '赢', draw: '平', lose: '输' };
    const meWin = res === 'human' ? 'win' : res === 'cpu' ? 'lose' : 'draw';
    const oppWin = res === 'cpu' ? 'win' : res === 'human' ? 'lose' : 'draw';
    const verdict = (who, tone) => (tone === 'draw' ? '平局' : `${who}${tone === 'win' ? '赢' : '输'}了`);

    // 对手上一轮出招：展示在出招格右侧的小格里
    if (last) {
      els.lastCpuMove.innerHTML = `<span class="glyph" data-move="${last.cpu}">${EMOJI[last.cpu]}</span>`;
      els.lastCpuMove.classList.add('show');
      // 悬浮提示说清楚是哪一招、结果如何（与两个角标同一套说法）
      els.lastCpuMove.setAttribute('data-tip',
        `上一局${oppName()}出 ${EMOJI[last.cpu]} ${NAMES[last.cpu]}，${verdict(oppName(), oppWin)}`);
    } else {
      els.lastCpuMove.innerHTML = '';
      els.lastCpuMove.classList.remove('show');
      els.lastCpuMove.removeAttribute('data-tip');
    }

    // 我方上一轮出招：在对应按钮右下角标注胜负
    els.choices.querySelectorAll('.choice').forEach((btn) => {
      const badge = btn.querySelector('.badge');
      const on = !!last && btn.dataset.move === last.human;
      if (on) {
        badge.textContent = word[meWin];
        badge.className = 'badge show ' + meWin;
        badge.setAttribute('data-tip', `上一局${meName()}出 ${EMOJI[last.human]} ${NAMES[last.human]}，${verdict(meName(), meWin)}`);
      } else {
        badge.textContent = '';
        badge.className = 'badge';
        badge.removeAttribute('data-tip');
      }
    });
    // 辅助模式：对手上一轮出的那一招，在补录按钮上同样标一份（角标 + 悬浮说明），
    // 与我方那三颗对称 —— 一眼看全上一局双方各出了什么、结果如何。
    const showOpp = isAssist() && !!last;
    els.cpuPick.querySelectorAll('.pick').forEach((btn) => {
      const badge = btn.querySelector('.badge');
      if (!badge) return;
      const on = showOpp && btn.dataset.move === last.cpu;
      if (on) {
        badge.textContent = word[oppWin];
        badge.className = 'badge show ' + oppWin;
        badge.setAttribute('data-tip', `上一局${oppName()}出 ${EMOJI[last.cpu]} ${NAMES[last.cpu]}，${verdict(oppName(), oppWin)}`);
      } else {
        badge.textContent = '';
        badge.className = 'badge';
        badge.removeAttribute('data-tip');
      }
    });
  }

  /* ============================== 分析面板 ============================== */

  function renderPanel() {
    renderCompare();      // 参数面板里的档位对比/探索判定独立于分析面板，随时保持最新
    renderRandomness();   // 不可预测性评估在左侧游戏区，同样与面板开关无关
    if (els.panel.hidden || !state.pending) return;
    const { metaProbs, cpuMove, bestCpu, bestTies, breakdown, epsilon, explore, sampled, weightSum, scores } = state.pending;

    // 预测概览（无真实依据时不显示预测）
    const hasData = breakdown.some((b) => !b.baseline && b.matched);
    if (!hasData) {
      els.forecast.innerHTML = `
        <div class="fc-head">${tx('下招预测（人类）')}</div>
        <div class="fc-empty">暂无数据 · 打几局后 AI 才有依据</div>`;
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

      // 电脑三招各自的期望收益（赢概率 − 输概率），高亮收益最高的一招（并列时都亮）
      const tieSet = bestTies && bestTies.length > 1 ? bestTies : null;
      const evRows = MOVES.map((c) => {
        const s = (scores && scores[c]) || 0;
        const hi = tieSet ? tieSet.includes(c) : c === bestCpu;
        return `<span class="fc-ev-chip${hi ? ' on' : ''}"><i>${EMOJI[c]}</i>${s >= 0 ? '+' : ''}${s.toFixed(2)}</span>`;
      }).join('');

      // 辅助模式给的是「建议我方出」，对战模式才是 AI 自己出招
      const assist = isAssist();
      const pickMove = assist ? bestCpu : cpuMove;
      const bv = (scores && scores[pickMove]) || 0;
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
      const targetLine = assist
        ? `建议我方出 <b>${EMOJI[pickMove]} ${NAMES[pickMove]}</b>${noData ? '（暂无可信依据）' : ''}`
        : `电脑选 <b>${EMOJI[cpuMove]} ${NAMES[cpuMove]}</b>${targetNote}`;
      const targetTip = assist
        ? 'AI 先预测对手最可能出什么，再按「期望收益最高」给出我方该出的招。'
        : 'AI 按「期望收益最高」的一招出招。括号说明本局的特殊情况：「随机出招」= 所有标准应验率均未超过随机基准，只能出随机招；「探索」= 本局触发探索扰动，并非按期望收益所选；「按分布取样」= 预测尚未显著优于随机，改按预测分布取样。';
      els.forecast.innerHTML = `
        <div class="fc-head">${tx('下招预测（人类）')}</div>
        ${bars}
        ${weightSum > 0
          ? `<div class="fc-ev" data-tip="${tx('每招的期望收益 = 该招击败人类的概率 − 该招被人类击败的概率，取最大者出招。')}"><span class="fc-ev-head">期望收益</span><div class="fc-ev-chips">${evRows}</div></div>`
          : `<div class="fc-alert">${tx('所有标准的应验率都没超过随机基准 33%，AI 暂无可信依据，本局只能随机出招。')}</div>`}
        <div class="fc-target" data-tip="${targetTip}">${targetLine}${noData ? '' : `，期望收益 <b>${bv >= 0 ? '+' : ''}${bv.toFixed(2)}</b>`}</div>
        ${state.pending.surge ? `<div class="fc-surge" data-tip="${tx('对方此前几乎不出这一招，最近却密集出现，于是 AI 临时把它的概率调高。它只影响本局预测，不改动长期统计。')}">${tx('检测到突变')}：最近 ${state.pending.surge.window} 局出现 ${state.pending.surge.count} 次 ${EMOJI[state.pending.surge.move]} ${NAMES[state.pending.surge.move]}</div>` : ''}
        ${assist ? '' : `<div class="fc-note" data-tip="${epsTip}">${noData ? '' : `本局随机出招概率 ${(epsilon * 100).toFixed(1)}%`}</div>`}
      `;
    }

    // 标准明细（默认按应验率降序；未匹配沉底；随机基线也参与排序）
    const ordered = breakdown.slice();
    if (App.panelSort === 'weight' || App.panelSort === 'acc') {
      const key = App.panelSort === 'weight' ? 'share' : 'accuracy';
      ordered.sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        return (b[key] || 0) - (a[key] || 0);
      });
    }
    const relName = (k) => ({ win: '胜', draw: '平', lose: '负' })[k];

    els.criteriaBody.innerHTML = ordered
      .map((item) => {
        const e = item.expert;
        const title = `<td class="c-name"><b>${tx(e.name)}</b><span class="c-desc">${tx(e.desc)}</span></td>`;

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
          ? tx('在「当前依据」所示的局面下，历史上人类各关系（胜/负/平）出现的次数')
          : tx(`在「当前依据」所示的局面下，历史上人类各招（${MOVES.map((m) => EMOJI[m]).join('/')}）出现的次数`);
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

  /** 档位对比的一行（标签 · 条形 · 数值），rate 为 null 时留空 */
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
    const tip = '本局实际采用的纯随机出招概率 = 三项中取最大值：'
      + items.map(([n, v, capped]) => `${n} ${(v * 100).toFixed(1)}%${capped ? '（受上限约束）' : '（不受上限约束）'}`).join('、')
      + `。当前由「${top[0]}」决定`
      + (top[2] ? '。' : '——它不受上限约束，故而高于参数面板中的「探索强度上限」。');
    return { top, tip };
  }

  /** 各档位的命中率对比（自动调参依据）与两项显著性判定 */
  function renderCompare() {
    if (!els.confCompare) return;
    const win = state.shadow.slice(-App.Z_WINDOW);
    const t = state.rateTable;
    const cur = Number(els.confInput.value) || 0;
    els.confCompare.innerHTML = cmpTitle('收缩档位命中率', win.length, tx('预测命中率 = 该档位对下一招的预测命中人类实际出招的比例（以当前半衰期为权重基准）')) +
      App.Z_CANDIDATES.map((zz, i) => cmpRow(String(zz), t ? t[i].rate : null, Math.abs(zz - cur) < 1e-9)).join('');

    if (els.hlCompare) {
      const dwin = state.decayShadow.slice(-App.HL.window);
      const dt = state.decayRateTable;
      const curHl = Number(els.hlInput.value) || 0;
      els.hlCompare.innerHTML = cmpTitle('记忆半衰期命中率', dwin.length, tx('预测命中率 = 该档位对下一招的预测命中人类实际出招的比例（各档位按自身半衰期加权）')) +
        App.DECAY_TIERS.map((v, i) => cmpRow(v + ' 局', dt ? dt[i].rate : null, v === curHl)).join('');
    }

    if (!els.exploreCompare) return;
    const st = state.exploreStat;
    const cap = st ? Math.round((state.exploreCap || 0) * 100) : null;
    const pd = state.pending;
    const epsInfo = pd ? epsBreakdown(pd) : null;
    els.exploreCompare.innerHTML =
      cmpTitle('探索上限判定', state.bestLog.slice(-App.Z_WINDOW).length,
        isAssist()
          ? '决定 AI 最多能加入多少「纯随机出招」。只有当对手已能反制它、它照预测出招反而赢不了时（胜率明显低于完全随机的 33%），才会开始加入随机。注意：该上限仅约束「探索强度」这一项。'
          : tx('决定 AI 最多能加入多少「纯随机出招」。只有当人类已能反制它、它照预测出招反而赢不了时（胜率明显低于完全随机的 33%），才会开始加入随机。'
            + '注意：该上限仅约束「探索强度」这一项。下方的「本局实际随机概率」还可能被开局随机度或自适应扰动抬高，因而高于上限，并不矛盾。')) +
      `<div class="exp-row" data-tip="${tx('最近这些局里，AI 每次都按预测最优的一招出招时实际赢下的比例（平局不计）。约 33% 即完全随机的水平；明显更低则说明人类已能反向利用其预判。')}"><span>按最优出招的胜率</span><b>${st ? (st.w * 100).toFixed(1) + '%' : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx(`实际参与统计的对局数（按半衰期加权后的等效数量，越近的对局权重越大；平局不计入）。样本过少时结果不可靠，故不足 ${App.Z_MIN_SAMPLES} 局不做判定。`)}"><span>有效局数</span><b>${st ? st.nEff.toFixed(1) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx('上述差距的显著性。≤ 1 视为无明显差别，此时完全不加入随机；达到 3 即视为确实可被针对，上限取满。')}"><span>可信程度</span><b>${st ? st.z.toFixed(2) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx('自动调参能为「探索强度」档位取到的最大值（由显著性检验决定）。该上限仅约束探索强度；开局随机度与自适应扰动不受其约束，因此本局实际随机概率可能高于它。')}"><span>探索强度上限</span><b>${cap == null ? '\u2014' : cap + '%'}</b></div>` +
      (isAssist() ? '' : `<div class="exp-row" data-tip="${epsInfo ? epsInfo.tip : '本局尚未开始。'}"><span>本局实际随机概率</span><b>${epsInfo ? (pd.epsilon * 100).toFixed(1) + '%' : '\u2014'}</b></div>`);

    if (!els.predictCompare) return;
    const ps = state.predictStat;
    const tp = Math.round((state.predictTrust || 0) * 100);
    els.predictCompare.innerHTML =
      cmpTitle('押注判定', state.hitLog.slice(-App.Z_WINDOW).length,
        isAssist()
          ? '辅助模式下 AI 不亲自出招（只给建议），这里展示的是模型内部的押注策略指标，仅供观察。'
          : tx('决定 AI 是否「押注」自己的预测。只有预测被证明确实优于随机时，它才挑期望收益最高的一招出；否则按预测分布随机取一招，避免长期出同一招而被人类反制。')) +
      `<div class="exp-row" data-tip="${tx('最近这些局里，AI 对下一招的预测命中人类实际出招的比例（跟它自己出什么招无关）。约 33% 即完全随机的水平；开局样本不足时各标准尚未形成依据，接近 33% 属正常现象。')}"><span>预测命中率</span><b>${ps ? (ps.w * 100).toFixed(1) + '%' : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx(`实际参与统计的对局数（按半衰期加权后的等效数量，越近的对局权重越大）。样本过少时结果不可靠，故不足 ${App.Z_MIN_SAMPLES} 局不做判定。`)}"><span>有效局数</span><b>${ps ? ps.nEff.toFixed(1) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx('「预测确实优于随机」这一判断的显著性。≤ 1 视为无差别，此时不押注；达到 3 则完全采信预测，每局押注最优招。')}"><span>可信程度</span><b>${ps ? ps.z.toFixed(2) : '\u2014'}</b></div>` +
      `<div class="exp-row" data-tip="${tx('本局直接押注最优招的概率，其余概率按预测分布取样（出招仍偏向其认为人类更可能出的一招，但不再固定）。')}"><span>押注概率</span><b>${tp}%</b></div>`;
  }

  /* ============================== 不可预测性评估 ============================== */

  /**
   * 不可预测性评估：直接套用 AI 自己的「预测命中率」当尺子。
   * 33%（随机基线）= 满分；命中率越高，说明你的出招越容易被抓住。
   */
  function randomnessReport() {
    // 命中率按「半衰期加权」口径（近局权重更大），与记分板里的 B 值一致
    const hs = App.hitStats();
    const n = hs.n;
    if (!(n >= App.Z_MIN_SAMPLES)) return null;

    const hitRate = hs.b;

    // 挑「收缩后应验率」最高的标准 = 你最容易被抓的破绽（小样本会被压向 1/3，避免噪声误报）
    let best = null;
    let bestAdj = 0;
    for (const e of App.predictor.experts) {
      if (e.baseline || e.tries < 3) continue;
      const adj = 1 / 3 + (e.accuracy - 1 / 3) * (e.tries / (e.tries + 6));
      if (adj > bestAdj) {
        bestAdj = adj;
        best = e;
      }
    }

    const cnt = { R: 0, P: 0, S: 0 };
    const predKey = isAssist() ? 'cpu' : 'human';   // 统计「被预测者」的出招分布
    for (const r of state.history) cnt[r[predKey]]++;
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

  /** 不可预测性评估（面板区块）；「人类 / 对手」视模式而定 */
  function renderRandomness() {
    if (!els.randomness) return;
    const r = randomnessReport();
    const over = !!r && r.score > 100;
    els.randomness.classList.toggle('over', over);
    els.randomness.classList.toggle('max', !!r && r.score >= 140);
    // 特效强度：前段快速抬升（刚破 100 就明显），150 分拉满
    const t = over ? Math.min(1, (r.score - 100) / 50) : 0;
    // 发光/流光挂在整张卡片上：内层 .rand 已降级为纯内容容器，读不到子级上的变量
    (els.randomness.closest('.rand-card') || els.randomness)
      .style.setProperty('--rand-power', (over ? 0.35 + 0.65 * Math.pow(t, 0.6) : 0).toFixed(3));
    if (!r) {
      // 样本不足：渲染同一套骨架（数值留空），让卡片高度与「评估出来之后」一致，避免跳变
      els.randomness.innerHTML = `
        <div class="rand-head">
          <span>${tx('人类不可预测性评估')}</span>
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
        <div class="rand-verdict">玩满 ${App.Z_MIN_SAMPLES} 局后开始评估</div>
        <div class="rand-note">样本满 ${App.Z_MIN_SAMPLES} 局后开始统计：命中率按<b>半衰期加权</b>口径（近局权重更大），并与随机基准 1/3 比较。</div>`;
      return;
    }
    const verdict =
      r.score >= 140 ? (isAssist() ? '对手简直是台机器：一点随机性都没有' : 'AI 彻底崩了：它对人类毫无还手之力——开挂了吧？！')
        : r.score > 110 ? (isAssist() ? '对手的套路已经被看透，反着它出招就赢' : 'AI 已经懵了——它的套路全被人类反手用在自己身上')
          : r.score > 100 ? (isAssist() ? '像是摸到了对手的门道，开始反着它出招' : '像是摸到了 AI 的门道，开始反着它出招')
            : r.score >= 90 ? '与真随机无显著差异，AI 无从利用'
              : r.score >= 65 ? '存在轻微规律，AI 可部分利用'
                : r.score >= 35 ? '规律较明显，AI 已能有效利用'
                  : '规律显著，极易被针对';
    const delta = r.best ? Math.round((r.best.accuracy - 1 / 3) * 100) : 0;
    const hl = Number(App.predictor.options.halfLife) || 16;
    const hlNote = `（半衰期 ${hl} 局）`;
    // 与随机基准 33% 的差值（百分点）
    const diffPct = (r.hitRate - 1 / 3) * 100;
    const diffText = `${diffPct >= 0 ? '高' : '低'} ${Math.abs(diffPct).toFixed(0)}pp`;
    const bestText = r.best && r.bestAdj > 1 / 3 + 0.01
      ? `<span class="rand-best"><b>${tx(r.best.name)}</b><span class="rand-best-val">${pctText(r.best.accuracy)}（${delta >= 0 ? '+' : ''}${delta}%）</span></span>`
      : '没有明显破绽';
    els.randomness.innerHTML = `
      <div class="rand-head">
        <span>${tx('人类不可预测性评估')}</span>
        <span class="rand-score${over ? ' over' : ''}" title="不可预测性评分：100 = 与随机基准（命中率 1/3）持平；可超过 100（越难预测越高，最高 150）。">${r.score}<i>/100</i></span>
      </div>
      <div class="rand-bar"><i style="width:${Math.min(100, r.score)}%"></i></div>
      <div class="rand-rows">
        <div class="rand-row" title="${tx('AI 对人类下一招的预测命中人类实际出招的比例（与电脑实际出招无关）；此处按半衰期加权，近局权重更大（半衰期为 0 时等同全部统计）。开局样本不足时各标准尚未形成依据，数值接近随机基准 33% 属正常现象。')}">
          <span class="rand-name">AI 预测命中率${hlNote}</span>
          <span class="rand-val">${pctText(r.hitRate)}</span>
          <span class="rand-sub">${diffText}</span>
        </div>
        <div class="rand-cmp" title="${tx('33% 是人类完全随机出招时 AI 亦能命中的比例（随机基准）；命中率低于它，说明 AI 反而把握不住人类。')}">
          <div class="rand-cmp-track"><i style="width:${(r.hitRate * 100).toFixed(1)}%"></i><u style="left:33.333%"></u></div>
          <div class="rand-cmp-legend"><span class="l0">0%</span><span class="lbase">随机基准 33%</span><span class="l100">100%</span></div>
        </div>
        <div class="rand-row" title="${tx('各「标准」中收缩后应验率最高的一项 —— 即人类最容易被把握的破绽（小样本会被压向 1/3，避免噪声误报）。')}">
          <span class="rand-name">最大可预测优势</span>
          <span class="rand-val">${bestText}</span>
        </div>
        <div class="rand-row" title="${tx(`人类全部对局里 ${MOVES.map((m) => EMOJI[m]).join(' / ')} 各自的出现比例（仅作直观参考）。`)}">
          <span class="rand-name">出招分布</span>
          <span class="rand-val dist">${MOVES.map((m) => `<b>${EMOJI[m]} ${((r.cnt[m] / r.total) * 100).toFixed(0)}%</b>`).join('')}</span>
        </div>
      </div>
      <div class="rand-verdict">${verdict}</div>
      <div class="rand-note">命中率按<b>半衰期加权</b>口径（近局权重更大）：z > 0（高于 1/3）扣分、最低 0；z < −0.5（明显低于 1/3）加分、最高 150（当前 z = ${r.z.toFixed(2)}，有效样本 ${Math.round(r.n)} 局）。</div>`;
  }

  /* ============================== 对局记录 ============================== */

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
        const label = res === 'human' ? `${meName()}赢了` : res === 'cpu' ? `${oppName()}赢了` : '平局';
        return `<span class="rec ${res}" title="第 ${base + i + 1} 局　${meName()} ${NAMES[r.human]} vs ${oppName()} ${NAMES[r.cpu]}　${label}"></span>`;
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
    els.historyStats.innerHTML = `最近 <b>${last10.length}</b> 局：${meName()} <b>${win}</b> 胜 <b>${draw}</b> 平 <b>${lose}</b> 负`;
  }

  /* ============================== NIST SP 800-22 ============================== */

  /** 把出招序列编码成比特流并跑完整 15 项检验，渲染成报告 */
  function renderNist() {
    const n = state.history.length;
    if (n < 64) {
      els.nistBody.innerHTML =
        `<div class="nist-loading">样本太少（当前 ${n} 局，需要至少 <b>64</b> 局）。<br />`
        + '样本太少时几乎必然满分，没有参考价值，所以不做检测。</div>';
      return;
    }
    const bits = NIST.buildBits(App.predView());
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
        <p><b>在测什么？</b>${tx('测的是<b>人类的出招序列有多像真随机</b>——也就是「人类的手够不够随机、有多容易被 AI 抓住」。')}</p>
        <p>${tx(`把每招按 2 比特编码成比特流（当前 <b>${bits.length}</b> 比特），再跑 NIST SP 800-22 的 <b>15 项</b>统计检验。
        每项检验都在问同一个问题：<b>这一段看起来像不像真随机</b>。全部通过 = 人类的出招与真随机无法区分；
        未通过的项目，就是 AI 可能加以利用的规律。`)}</p>
      </div>
      <div class="nist-score">
        <div class="nist-score-top"><span>${tx('人类随机性评分')}</span><b>${score}<i>/100</i></b></div>
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
        <p><b>p 值怎么读？</b>${tx('p 值是「<b>假如人类的出招完全随机</b>，单靠运气也能出现这么极端结果的概率」。')}</p>
        <p>${tx(`所以<b> p 越大 = 越看不出异常</b>：比如 p = 0.40，意思是「随机的话有 40% 的机会看起来比这还夸张」，完全正常；
        而 p = 0.005，意思是「随机的话只有 0.5% 的机会会这样」，小到不太像巧合，于是判为「有规律」。`)}</p>
        <p>${tx(`判定线用 NIST 惯例的 <b>0.01</b>：<b>≥ 0.01 通过</b>、<b>0.01 ~ 0.05 边缘</b>（有点可疑，但还不足以下结论）、<b>低于 0.01 未通过</b>。
        p 值不是「人类随机的概率」，也不是越大越好——只要不低于 0.01，就说明这项检验没抓到问题。`)}</p>
      </div>
      <table class="nist-table">
        <thead><tr><th>#</th><th>检验项</th><th title="该项检验算出的数值，与 p 值一一对应">统计量</th><th title="${tx('若人类出招完全随机，出现同等极端结果的概率。≥ 0.01 视为通过。')}">p 值</th><th title="通过 = 没抓到规律；未通过 = 这项检验发现了可疑规律">判定</th></tr></thead>
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

  Object.assign(App, {
    renderScores, renderArena, renderPanel, renderCompare,
    renderRandomness, renderHistory, renderNist, epsBreakdown,
  });
})(window);
