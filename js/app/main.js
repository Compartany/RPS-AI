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
        预测人类出: `${NAMES[d.target]}(${d.target})`,
        预测最大概率: Math.max(d.metaProbs.R, d.metaProbs.P, d.metaProbs.S),
        探索概率: d.epsilon,
        押注概率: d.trust,
        时间戳: t.toISOString(),
      }
    );
  }

  /* ============================== 流程 ============================== */

  /**
   * 本局是不是「很久没玩之后」的一局；是的话另起一段（state.seg++），
   * 断点另一侧的局不再与本局拼成同一条序列。
   * 窗口类观测（最近 N 局的命中与各档位战绩、押注与探索判定的过程值）一并清零 ——
   * 断链后的前 12 局里，押注判定与自动调参的择优因样本不足而静默，与全新开局的头几局同一表现；
   * 而累计战绩、各标准的依据值与已调好的参数一概保留。
   */
  function breakIfStale() {
    const now = Date.now();
    if (!state.lastAt || now - state.lastAt <= App.ROUND_GAP_MS) return false;
    state.seg++;
    state.segStart = state.history.length;
    state.hitLog = [];
    state.bestLog = [];
    state.shadow = [];
    state.shadowTargets = null;
    state.rateTable = null;
    state.decayShadow = [];
    state.decayTargets = null;
    state.decayRateTable = null;
    state.exploreStat = null;
    state.exploreCap = 0;
    state.predictStat = null;
    state.predictTrust = 0;
    state.streak = { side: null, count: 0 };
    state.lastResult = null;
    state.lastAt = now;      // 新段从此刻起算
    return true;
  }

  function startRound() {
    breakIfStale();          // 很久没玩（含刚载入存档）之后回来，本局与旧局不再算同一段
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
    // 开局后挂了很久（超过阈值）才出招：本局就是断链后的第一局，窗口与统计都从它开始数。
    // （本局的预测是开局时算的，那时确实还算连续；段首局不再判定，免得重复另起一段）
    if (state.history.length !== state.segStart) breakIfStale();

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
    state.history.push({ human: myMove, cpu: oppMove, seg: state.seg });
    state.lastAt = Date.now();   // 本局的时刻：下一局据此判定「隔了多久」
    App.bumpActivity();      // 这份数据刚玩过（名字框候选按「最近玩过」排序）

    autoTuneStep();

    renderScores();
    renderArena();
    renderPanel();
    renderHistory();
    App.autosave();          // 每局结算后就落盘：刷新最多只吃掉正在打的那一局

    setTimeout(() => {
      if (state.revealed) startRound();
    }, 850);
  }

  function resetAll() {
    delete App.parked[state.key];       // 只重置当前这一份（当前玩法 / 当前对手），其余的原地保留
    Object.assign(state, App.emptyProfile());
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    App.predictor = newPredictor(App.ORDER);
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
    App.autosave();
  }

  /* ============================== 存档 ============================== */

  /** 文件名安全化：去掉 Windows 不允许的字符与首尾的点/空白，并限制长度 */
  function safeFileName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 24);
  }

  function exportSave() {
    // 文件名带上「被预测者」的名字（对战模式 = 我，辅助模式 = 对手）：同名就同名，一眼能分清是谁的数据。
    // 不加 rps- 前缀、也不带模式：扩展名已经说明这是什么，同一份数据两种玩法又通用。
    const who = safeFileName(isAssist() ? state.opponent : state.userName);
    const blob = new Blob([App.buildSave()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${who ? who + '-' : ''}${new Date().toISOString().slice(0, 10)}.rps`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importSave(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let d;
      try {
        d = App.parseSave(reader.result);
      } catch (err) {
        alert('存档导入失败：' + err.message);
        return;
      }
      // 导入会顶掉现有的一切，也问一句
      askConfirm('确定导入？现有数据将被覆盖。', '导入', () => {
        try {
          applySave(d);
        } catch (err) {
          alert('存档导入失败：' + err.message);
        }
      });
    };
    reader.onerror = () => alert('存档读取失败');
    reader.readAsText(file);
  }

  /**
   * 把一份存档装回工作区。
   * @param activeKey 明确指定「当前档」是谁（自动存档会记下）；手动导入不传，就按存档里的「模式 + 名字」算
   */
  function applySave(d, activeKey) {
    if (!d || !d.profiles) throw new Error('格式不正确（缺少数据段）');

    // 所有档案各自就位：目标那份搬进工作区，其余的留在寄存位备用
    for (const k of Object.keys(App.parked)) delete App.parked[k];
    Object.assign(App.parked, d.profiles);
    state.mode = d.mode;
    // activeKey 传 null = 「当前档刻意留空」（启动时选「空白开始」），名字框也一并留空；
    // 否则按名字算出来的键仍会指回某个人，把那个人的档案当成当前档装在身上 ——
    // 紧接着的自动存档就会把此人的记录覆盖成空段。
    const blank = activeKey === null;
    state.userName = blank ? '' : d.user;
    state.opponent = blank ? '' : d.opponent;
    // 自动存档会把上次的当前档原样记下（无名档记成 null）。上次没起名字时不能退回「按名字算」——
    // 那样会把某个有名字的档案当成当前档装在身上，之后打的局全记到别人名下。
    const key = activeKey !== undefined ? activeKey : (d.key || App.currentKey());
    if (key && App.parked[key]) {
      App.takeProfile(key, true);      // 手动导入：没名字的那份也照样读回来
    } else {
      state.key = key || App.currentKey();
      App.setProfileIntoState(null);
    }
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
    App.autosave();          // 导入 / 恢复之后立刻落盘，之后刷新就是这一份
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

  /**
   * 名字候选浮层。没用原生 datalist：它由系统绘制（浅色底 + 大三角），跟页面的玻璃风格完全不搭 ——
   * 而且只要挂了 list 属性，输入框一聚焦就会被画成系统下拉框的样子。这里自己画一份。
   * 人多了也不怕：列表自己限高滚动，而且会按框里已经打进去的字实时筛。
   */
  function showNameMenu() {
    const q = els.nameInput.value.trim().toLowerCase();
    const names = App.knownNames().filter((n) => !q || n.toLowerCase().indexOf(q) >= 0);
    els.nameMenu.innerHTML = '';
    if (!names.length) {
      els.nameMenu.hidden = true;
      return;
    }
    for (const n of names) {
      const row = document.createElement('div');
      row.className = 'name-item';

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'name-pick';
      pick.textContent = n;
      // 用 mousedown 并阻止默认行为：抢在输入框失焦之前把名字填进去
      pick.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        els.nameInput.value = n;
        commitName();                  // 点一项 = 就用这个名字（跟点「保存」走同一条路）
        els.nameInput.blur();
      });

      // 单独清掉这个人的数据（不用先切过去再点「重置数据」）
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'name-del';
      del.textContent = '\u00d7';
      del.setAttribute('aria-label', `删除「${n}」及其记录`);
      // 叉用描边图标：文本的「×」在行框里天生偏上（乘号位于 x 高度区），
      // 在这么小的方块里一眼就能看出歪；图标与按钮同为 1:1 的盒子，grid 居中即真正居中。
      del.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 L8 8 M8 2 L2 8" /></svg>';
      del.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        deleteProfile(n);
      });

      row.appendChild(pick);
      row.appendChild(del);
      els.nameMenu.appendChild(row);
    }
    els.nameMenu.hidden = false;
  }

  /**
   * 框内那颗按钮该露哪一颗（两者共用同一个槽位，互斥）：
   *   · 改过、且框里不为空 → 「保存」
   *   · 没改过、且框里不为空 → 「×」（清空，指针移到框上才露）
   * 空框两颗都不给：要清空有「×」，手删到空再按保存没有意义。
   */
  function syncNameSave() {
    const v = els.nameInput.value;
    const dirty = v !== App.predictedName();
    const hasText = !!v.trim();
    els.nameBox.classList.toggle('dirty', dirty && hasText);
    els.nameBox.classList.toggle('can-clear', !dirty && hasText);
  }

  let nameToastTimer = 0;

  /** 名字没保存上的小通知：贴在名字框下面浮 1.5s 自己退场（重复触发就重新计时） */
  function showNameToast(text) {
    els.nameToast.textContent = text;
    els.nameToast.classList.add('show');
    clearTimeout(nameToastTimer);
    nameToastTimer = setTimeout(() => els.nameToast.classList.remove('show'), 1500);
  }

  /** 提前收起：聚焦时那块地方要让给候选列表，两个叠在一起会看不清 */
  function hideNameToast() {
    clearTimeout(nameToastTimer);
    els.nameToast.classList.remove('show');
  }

  /**
   * 收下输入框里的名字：对战模式给我方命名，辅助模式给对手命名，顺带收起候选。
   * 名字只有走到这里才生效（按保存 / 回车 / 点候选）—— 顺手点开别的地方、离开输入框都不算。
   */
  function commitName() {
    const v = els.nameInput.value;
    if (isAssist()) setOpponent(v);
    else setUserName(v);
    els.nameMenu.hidden = true;
    syncNameSave();
    App.autosave();          // 改名 = 换一份档案，落盘的内容也要跟着换
  }

  /**
   * 把当前模式反映到界面：按钮文案、录入区显隐、全部称谓。
   * @param keepPanel 保持面板当前的开合状态（只是改个名字时用；换模式要按新模式重设）
   */
  function syncModeUI(keepPanel) {
    els.arena.dataset.mode = state.mode;
    els.modeName.textContent = App.MODE_LABEL[state.mode];
    els.cpuPick.hidden = !isAssist();
    // 名字框一框两用：对战模式的对手恒为 AI，能起名字的就是「我」；辅助模式则是对手。
    // 框里不写「我 / 对手」标签（两个词并排会读成一句话），身份改由占位文字说明。
    els.nameInput.value = isAssist() ? state.opponent : state.userName;
    els.nameInput.placeholder = isAssist() ? '对手名字' : '我的名字';
    els.nameBox.setAttribute('data-tip',
      '填写名字后该数据才会保留（换名即换一份）；留空则在切换模式或刷新页面时清除，手动导出存档除外。');
    els.nameMenu.hidden = true;            // 换模式/换名字时把候选收起来
    syncNameSave();                        // 框里的字刚被回写成生效的名字，保存按钮该收起来
    // 「我方 / 对手」的称谓不走互换（互换针对的是「被预测者 / cpu 侧」），直接按模式写
    els.oppAvatar.textContent = isAssist() ? App.oppName() : 'AI';
    els.cpuLabel.textContent = `${App.oppName()}胜率`;
    els.oppPickLabel.textContent = `${App.oppName()}出了`;
    // 小格（上一轮对面的出招）的提示由 renderLast() 按当轮数据写，这里不再写死：
    // 两种模式下看的是不同的人（对战看电脑、辅助看真人对手），但措辞跟着 oppName() 走
    els.meAvatar.textContent = App.meName();
    // 起过名字就用名字；对战模式没起名叫「人类」（与左侧评估卡片一致），辅助模式恒为「我方」
    els.humanLabel.textContent = state.userName && !isAssist()
      ? `${state.userName}胜率`
      : (isAssist() ? '我方胜率' : '人类胜率');
    els.modeBtn.setAttribute('data-tip', isAssist()
      ? 'AI 代我方出招（点击切换到对战模式）'
      : '人类 vs AI（点击切换到辅助模式）');
    applyTerms();
    // 面板默认状态：辅助模式展开（要边出边看预测依据），对战模式收起
    if (!keepPanel) togglePanel(isAssist());
  }

  /** 换档之后重开一局：清掉局内状态，按新档案重建模型与界面 */
  function restartRound(keepPanel) {
    state.revealed = false;
    state.revealedMove = null;
    state.revealedOpp = null;
    state.picks = { opp: null, me: null };
    state.pending = null;
    syncModeUI(keepPanel);
    App.predictor = newPredictor(App.ORDER);
    App.predictor.replay(predView());
    rebuildDecayModels();
    renderScores();
    renderHistory();
    startRound();
    App.autosave();          // 换档 / 切模式 / 重置之后，落盘的内容也跟着换
  }

  /**
   * 换到「当前模式 + 当前名字」对应的那份数据：先把现在这套寄存好，再取回目标那套。
   * 名字没变时走这一趟也安全（存进去再取出来，数据原样）—— 名字才决定数据归谁，
   * 所以「改名」就等于「换一份数据」。
   */
  function switchProfile() {
    App.parkProfile();
    App.takeProfile(App.currentKey());
    restartRound(true);            // 只是换个名字：别把面板的开合状态也重置了
  }

  /** 切换玩法：两种玩法下「被预测的人」可能不是同一个，所以换完要重新取档案 */
  function setMode(mode) {
    if (mode === state.mode) return;
    App.parkProfile();                 // 先按旧模式的口径寄存（辅助模式的现场是「我方 / 对手」）
    state.mode = mode;
    App.takeProfile(App.currentKey()); // 再按新模式的口径取回 —— 名字相同时就是同一份数据，接着往下记
    restartRound(false);
  }

  /**
   * 给「还没名字」的那份数据起个名：只把归属改到这个名下，数据原地不动。
   * （所以没名字时打的几局不会白打 —— 起个名就留下了。）
   */
  function adoptProfile() {
    state.key = App.currentKey();
    syncModeUI(true);
    renderScores();
    renderArena();
    renderPanel();
    renderHistory();
  }

  // 本次会话里删过几个人；以及「本次不再提醒」开关（都只在内存里，刷新页面即恢复提醒）
  let deletedCount = 0;
  let skipDeleteAsk = false;

  /**
   * 删除某个人（先问一句）。
   * 连删第二个起，确认框会多一个「本次不再提醒」—— 它只活在这次页面会话里，刷新后又开始问。
   */
  function deleteProfile(name) {
    if (skipDeleteAsk) {
      removeProfile(name);
      return;
    }
    const doIt = () => {
      deletedCount++;
      removeProfile(name);
    };
    askConfirm(
      `确定删除「${name}」及其记录？`,
      '删除',
      doIt,
      deletedCount >= 1
        ? { label: '删除（不再提醒）', onPick: () => { skipDeleteAsk = true; doIt(); } }
        : null
    );
  }

  /**
   * 真正删掉某个名字下的数据。
   * 正好是当前在用的那份时，连名字一起清掉并回到「还没起名」—— 否则列表里会留一个空壳，
   * 看着像没删掉。（只想清空数据、名字接着用，那是「重置数据」按钮的事。）
   */
  function removeProfile(name) {
    const key = 'p:' + App.cleanName(name);
    delete App.parked[key];
    if (state.key === key) {
      if (isAssist()) state.opponent = '';
      else state.userName = '';
      state.key = App.currentKey();
      App.setProfileIntoState(null);
      restartRound(true);
    }
    showNameMenu();                // 列表里把这个名字摘掉
    App.autosave();                // 删掉的人不该在下次刷新之后又回来
  }

  /**
   * 改完名字之后该干什么：
   *   原来就带着名字 → 换一份数据（旧名字那份留在原地）
   *   原来没名字、这个名字又是全新的 → 把手上这份直接归给它（＝给刚打的这些起个名）
   *   原来没名字、但这个名字已经有数据 → 取回那一份
   */
  function afterRename(wasUnnamed) {
    const key = App.currentKey();
    if (wasUnnamed && !App.parked[key]) adoptProfile();
    else switchProfile();
  }

  /** 给我方起名（对战模式）：名字就是这个人的数据归到哪一份 */
  function setUserName(name) {
    const clean = App.cleanName(name);
    els.nameInput.value = clean;           // 立即回写：去空白、截断后的结果当场可见
    if (clean !== state.userName) {
      const wasUnnamed = !App.cleanName(App.predictedName());   // 改之前还没名字？
      state.userName = clean;
      afterRename(wasUnnamed);
    }
    syncNameSave();                        // 已回写、已换好档：按钮该收就收
  }

  /** 给对手起名（辅助模式）：同上，名字决定这份数据是谁的 */
  function setOpponent(name) {
    const clean = App.cleanName(name);
    els.nameInput.value = clean;           // 立即回写：去空白、截断后的结果当场可见
    if (clean !== state.opponent) {
      const wasUnnamed = !App.cleanName(App.predictedName());   // 改之前还没名字？
      state.opponent = clean;
      afterRename(wasUnnamed);
    }
    syncNameSave();                        // 已回写、已换好档：按钮该收就收
  }

  function togglePanel(show) {
    const open = show === undefined ? els.panel.hidden : show;
    els.panel.hidden = !open;
    els.layout.classList.toggle('with-panel', open);
    els.panelBtn.textContent = open ? '收起分析' : '展开分析';
    if (open) renderPanel();
  }

  /* ============================== 事件 ============================== */

  /* ---------- 二次确认 ---------- */

  // 待确认的动作（点「确认」时执行）
  let askAction = null;
  let askExtraAction = null;
  let askCloseAction = null;       // 关掉浮层（取消 / Esc / 点背景）时要执行的收尾动作

  /**
   * 不可逆操作先问一句（自绘浮层；原生 confirm 太丑，也不属于这个页面的风格）。
   * @param extra 可选的次要动作 { label, onPick }，靠左显示 —— 用于「本次不再提醒」这类一次性选项
   */
  function askConfirm(text, okLabel, onOk, extra) {
    els.askText.textContent = text;
    els.askOk.textContent = okLabel;
    els.askOk.className = 'btn danger';      // 会丢东西的动作统一用危险色
    els.askCancel.textContent = '取消';
    askAction = onOk;
    askCloseAction = null;
    if (extra) {
      els.askExtra.textContent = extra.label;
      els.askExtra.hidden = false;
      askExtraAction = extra.onPick;
    } else {
      els.askExtra.hidden = true;
      askExtraAction = null;
    }
    els.askModal.hidden = false;
    els.askCancel.focus();           // 焦点给「取消」：手快回车也不会误删
  }

  function closeAsk() {
    const run = askCloseAction;
    els.askModal.hidden = true;
    els.askExtra.hidden = true;
    askAction = null;
    askExtraAction = null;
    askCloseAction = null;
    if (run) run();
  }

  els.askOk.addEventListener('click', () => {
    const run = askAction;
    closeAsk();
    if (run) run();
  });
  els.askExtra.addEventListener('click', () => {
    const run = askExtraAction;
    closeAsk();
    if (run) run();
  });
  els.askCancel.addEventListener('click', closeAsk);
  els.askBackdrop.addEventListener('click', closeAsk);

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

  els.nameInput.addEventListener('focus', () => { hideNameToast(); showNameMenu(); });
  els.nameInput.addEventListener('input', () => { showNameMenu(); syncNameSave(); });   // 边打边筛，顺便看要不要露出保存按钮
  // 没保存就离开输入框：把框里的字丢回去，还原成已生效的名字 —— 免得框里显示的和图上用的对不上
  els.nameInput.addEventListener('blur', () => {
    els.nameMenu.hidden = true;
    const now = App.predictedName();
    if (els.nameInput.value !== now) {
      els.nameInput.value = now;
      syncNameSave();
      showNameToast('名字没保存上');
    }
  });

  // 名字框一框两用（对战 = 我，辅助 = 对手），但两种情况下都只在明确保存时才生效：
  // 回车、或点框内的「保存」；从候选列表里选一项也算。单单离开输入框不算 ——
  // 顺手点一下别处就把名字换了会连带把数据换档，太随便了。
  els.nameInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    commitName();
  });
  // 用 mousedown 抢在输入框失焦之前生效（click 也行，但这里跟候选列表保持一致）
  els.nameSave.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    commitName();
  });
  // 清空名字：清空并立刻生效，也就是切回无名档。之后若不另填名字，离开输入框也保持无名档
  // （已生效的名字本来就是空的，没什么可还原）；接着输新名字再按保存即可。
  els.nameClear.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    els.nameInput.value = '';
    commitName();
    els.nameInput.focus();      // 留在框里接着输；聚焦会带出候选列表
  });

  document.addEventListener('keydown', (ev) => {
    // 确认浮层优先：在输入框里按 Esc 也应该能关掉它
    if (ev.key === 'Escape' && !els.askModal.hidden) {
      closeAsk();
      return;
    }
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape' && !els.nistModal.hidden) {
      els.nistModal.hidden = true;
      return;
    }
    if (!els.askModal.hidden) return;
    if (!els.nistModal.hidden) return;
    const idx = ['1', '2', '3'].indexOf(ev.key);
    if (idx >= 0) {
      ev.preventDefault();
      if (isAssist()) pickOpp(MOVES[idx]);   // 辅助模式：数字键补录「对手」的招
      else play(MOVES[idx]);
    }
  });

  /** 清空全部：所有名字的档案一并删掉，回到还没起名的状态 */
  function wipeAll() {
    for (const k of Object.keys(App.parked)) delete App.parked[k];
    if (App.isNamedKey(state.key)) {
      if (isAssist()) state.opponent = '';
      else state.userName = '';
      state.key = App.currentKey();
    }
    App.setProfileIntoState(null);
    restartRound(false);
  }

  // 「重置数据」先问范围：只清当前这份，还是全部清空。后者更狠，所以选它还得再确认一次。
  els.resetBtn.addEventListener('click', () => {
    askConfirm('确定删除记录？', '删除当前', resetAll, {
      label: '删除全部',
      onPick: () => askConfirm('确定删除全部数据？', '删除全部', wipeAll),
    });
  });
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
    els.hlOut.textContent = v + ' 局';
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

  /** 全新开局：把界面与模型按空白状态立起来 */
  function startFresh() {
    syncModeUI();
    renderScores();
    renderHistory();
    App.syncParamDisabled();
    rebuildDecayModels();
    autoTuneStep();
    startRound();
  }

  /**
   * 按存档立起来。
   * @param activeKey 当前档用哪一份；传 null 表示当前档留空 —— 其余档案照旧装进寄存位，
   *                  名字框的候选里还能把他们选回来。只有整份存档读不出来时才退回全新开局。
   */
  function restore(saved, activeKey) {
    try {
      applySave(saved.data, activeKey);
      App.syncParamDisabled();
    } catch (e) {
      console.warn('自动存档读回失败，按新开局处理：', e);
      startFresh();
    }
  }

  /**
   * 启动时先问一句要不要接着上次玩，上一次的模式、名字与局数都写在问题里。
   * 两个选项都会把存档装回来（所以名字框候选与其它档案不会丢），区别只在当前档是谁。
   * @param saved loadAutosave() 的结果；只有 active 是「有名字」的档时才会问到这儿
   */
  function askRestore(saved) {
    const d = saved.data;
    const key = saved.active;
    const seg = key && d.profiles[key] ? d.profiles[key] : null;
    const who = d.mode === 'assist' ? d.opponent : d.user;
    const bits = [App.MODE_LABEL[d.mode], who || '未起名'];
    const rounds = seg ? seg.fields.history.length : 0;
    if (rounds) bits.push(rounds + ' 局');   // 刚起名还没玩过就不提局数
    els.askText.textContent = '要载入上次的数据吗？（' + bits.join(' · ') + '）';
    els.askOk.textContent = '载入';
    els.askOk.className = 'btn primary';     // 「载入」是这里的主操作，给它主色
    els.askCancel.textContent = '空白开始';
    els.askExtra.hidden = true;
    askAction = () => restore(saved, key);
    askExtraAction = null;
    askCloseAction = () => restore(saved, null);   // 不接着上次那份：存档照旧装回来，只是当前档留空
    els.askModal.hidden = false;
    els.askOk.focus();               // 回车即「载入」
  }

  // 上次的记录不直接装回来，先问一句。不过上次结束时若那份档案就没名字（active 为 null），
  // 载入也只是当前档空白，没什么可问的 —— 直接按存档立起来，其余档案仍在名字框候选里。
  // 老存档没有 active 字段（undefined）时照问：那时只能按「模式 + 名字」去认，不能假定它没名字。
  const saved = App.loadAutosave();
  if (!saved) startFresh();
  else if (saved.active !== null) askRestore(saved);
  else restore(saved, null);
})(window);
