/*!
 * RPS-AI · 应用上下文
 *
 * 常量、DOM 引用、运行状态、称谓与参数读写 —— 应用层各模块共享的底座。
 */
(function (global) {
  'use strict';

  const { Predictor } = global.RPS;

  /* ============================== 常量 ============================== */

  // 记忆阶数：固定为 3（不再支持自定义；阶数越高越关注长序列规律，但样本需求也越大）
  const ORDER = 3;

  // 连续对局的时限：相邻两局间隔超过它，就视为「很久之前的对局」—— 断点两边的局不算同一段，
  // 当前局的序列不跨过去拼。阈值比「正常连续对局」宽松得多：一局只需几秒，中断片刻不算断。
  const ROUND_GAP_MS = 3 * 60 * 1000;

  const MODE_LABEL = { duel: '对战模式', assist: '辅助模式' };

  // 自动调参：候选的样本收缩档位（0 = 完全按应验率加权）、评估窗口与最少样本
  const Z_CANDIDATES = [0, 0.5, 1, 1.5, 2];
  const Z_WINDOW = 40;
  const Z_MIN_SAMPLES = 12;
  // 记忆档位的择优口径：窗口比 Z_WINDOW 短、门槛比默认的换档门槛低 ——
  // 对手一改招，长记忆要十几局才缓得过来，短记忆则立刻显出优势，换档必须跟得上变招。
  const HL = { window: 20, margin: 0.015 };
  // 记忆衰减档位（半衰期，局），取 2 的幂便于按对数均匀覆盖，只保留会遗忘的档位
  // （不含「不遗忘」：永久等权记忆会让很久以前的老习惯一直拖着新数据，无法适应打法变化）
  const DECAY_TIERS = [64, 32, 16, 8];
  // 探索强度档位（保底纯随机概率），从低到高；自动调参在此之间按电脑胜率择优
  const EXPLORE_TIERS = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 1];

  const SAVE_FORMAT = 'rps-ai-save';
  const SAVE_VERSION = 6;                    // 6：段里加连续段断点（breaks）与上一局时间戳（lastAt）
                                             // 5：档案改按「被预测者的名字」分（`p:名字`），不再按模式分

  // 每种玩法各自寄存的累积字段 —— 局内的（pending / revealed / picks …）每局都会重来，不必存
  const PROFILE_FIELDS = [
    'history', 'seg', 'segStart', 'lastAt', 'stats', 'hit', 'hitTries', 'hitLog', 'ideal', 'bestLog',
    'shadow', 'shadowTargets', 'rateTable',
    'decayShadow', 'decayTargets', 'decayRateTable',
    'exploreStat', 'exploreCap', 'predictStat', 'predictTrust', 'predictDrop',
    'streak', 'lastResult',
  ];

  /* ============================== DOM 引用 ============================== */

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
    askModal: $('askModal'),
    askBackdrop: $('askBackdrop'),
    askText: $('askText'),
    askOk: $('askOk'),
    askExtra: $('askExtra'),
    askCancel: $('askCancel'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    importFile: $('importFile'),
    arena: $('arena'),
    choices: $('choices'),
    cpuMove: $('cpuMove'),
    cpuTag: $('cpuTag'),
    humanTag: $('humanTag'),
    resultBanner: $('resultBanner'),
    modeBtn: $('modeBtn'),
    modeName: $('modeName'),
    nameBox: $('nameBox'),
    nameInput: $('nameInput'),
    nameMenu: $('nameMenu'),
    nameSave: $('nameSaveBtn'),
    nameClear: $('nameClearBtn'),
    nameToast: $('nameToast'),
    meAvatar: $('meAvatar'),
    oppAvatar: $('oppAvatar'),
    oppPickLabel: $('oppPickLabel'),
    cpuLabel: $('cpuLabel'),
    humanLabel: $('humanLabel'),
    cpuPick: $('cpuPick'),
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

  /* ============================== 运行状态 ============================== */

  const state = {
    history: [],                       // [{ human, cpu, seg }]；seg = 该局所在的「连续段」编号
    seg: 0,                            // 当前连续段编号（很久没玩会另起一段）
    segStart: 0,                       // 当前段的第一局在 history 中的下标
    lastAt: 0,                         // 上一局的时间戳（相邻两局间隔超过 ROUND_GAP_MS 即断链）
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
    mode: 'duel',                      // 'duel' 对战模式 | 'assist' 辅助模式
    userName: '',                      // 对战模式的「我」的名字（'' = 没起名）
    opponent: '',                      // 辅助模式的对手名字（'' = 没起名）
    key: 'duel',                       // 当前工作区对应的档案键（见 profileKey）
    seq: 0,                            // 「最近玩过」的序号，越大越新（名字框候选按它排序）
    picks: { opp: null, me: null },    // 辅助模式：本局补录的对手出招（我方出招默认 AI 推荐，可改选）
    revealedOpp: null,                 // 本局对手的实际出招（揭示时展示）
  };

  // 不在用的那些档案：键见 profileKey（`p:名字` / 'duel' / 'assist'），切走时才写入
  const parked = {};

  /* ============================== 文本 / 称谓 ============================== */

  const isAssist = () => state.mode === 'assist';

  /**
   * 两种模式下「我方（human 字段）」与「对手（cpu 字段）」的称呼：
   *   我方   —— 对战模式是「人类」（起过名字就用名字）；辅助模式**恒为「我方」**（只是个无身份的
   *             占位：AI 替其出招的那一侧，名字框在辅助模式指的是对手，与它无关）
   *   对手   —— 对战模式是「电脑」（AI）；辅助模式是真人「对手」（不再叫「电脑」）
   * 说明文案统一按 duel 的口径写（「人类」= 被预测者、「电脑」= cpu 字段那侧），
   * 切到辅助模式时用 tx() 把角色词换掉；另外「人类」在辅助模式下改称「对手」。
   */
  function tx(s) {
    if (!isAssist()) return s;
    return String(s)
      .split('电脑').join('\u0001')   // 先占位，避免与「人类」的替换相互干扰
      .split('人类').join('对手')
      .split('你').join('对手')
      .split('\u0001').join('我方');
  }

  /** 预测器视图：把「被预测者」放进 human 字段（预测器只区分 human / cpu 两列） */
  function predView() {
    return isAssist()
      ? state.history.map((r) => Object.assign({}, r, { human: r.cpu, cpu: r.human }))
      : state.history;
  }

  /**
   * 我方（human 字段一方）的称谓：对战模式是「人类」（起过名字就用名字）；
   * 辅助模式恒为「我方」—— 那里它是无身份的占位，起名字（名字框填的是对手）不该影响它
   */
  const meName = () => (isAssist() ? '我方' : state.userName || '人类');

  /** 对手（cpu 字段一方）的称谓：对战模式是「电脑」，辅助模式是真人对手（起了名字就用名字） */
  const oppName = () => (isAssist() ? (state.opponent || '对手') : '电脑');

  /* ============================== 档案身份 ============================== */

  // 名字长度上限（与输入框的 maxlength 保持一致）
  const NAME_MAX = 8;

  /** 规范化名字：去首尾空白、内部空白压成一个空格、截断到上限 */
  const cleanName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);

  /**
   * 「被预测者」的名字 —— 档案就是按这个人分的：
   *   对战模式：坐在屏幕前的人就是被预测者，名字框里填的「我的名字」就是他的名
   *   辅助模式：被预测的是对手
   * 所以两种模式填同一个名字，就是同一份数据 —— 同一个人在两种玩法下的记录会累积到一起，
   * 模型也一起学（对他来说，对面坐的是 AI 还是你，都是「对手」）。
   */
  const predictedName = () => (isAssist() ? state.opponent : state.userName);

  /** 名字对应的档案键：`p:名字`；没起名字就退回按模式的默认档（对战 / 辅助各一份） */
  function profileKey(mode, userName, opponent) {
    const n = cleanName(mode === 'assist' ? opponent : userName);
    if (n) return 'p:' + n;
    return mode === 'assist' ? 'assist' : 'duel';
  }

  /** 当前该用哪份档案（按现在的名字算） */
  const currentKey = () => profileKey(state.mode, state.userName, state.opponent);

  /** 已经记过的名字（给名字框当候选），**最近玩过的排前面** */
  function knownNames() {
    const seqOf = new Map();
    const put = (name, seq) => {
      const prev = seqOf.get(name);
      if (prev == null || seq > prev) seqOf.set(name, seq);
    };
    for (const k of Object.keys(parked)) {
      if (k.indexOf('p:') === 0 && parked[k]) put(k.slice(2), parked[k].seq || 0);
    }
    const cur = cleanName(predictedName());
    if (cur) put(cur, state.seq || 0);
    return [...seqOf.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }

  // 档案「最近玩过」的先后：单调递增，越大越新
  let seqCounter = 0;

  /** 标记当前这份刚玩过（每局结算后调用，供候选列表排序） */
  function bumpActivity() { state.seq = ++seqCounter; }

  /**
   * 交换一套档案里「我方 / 对方」两列的字段。
   * 档案统一按「被预测者在先」存（预测器要的就是这一口径），而辅助模式的现场是
   * 「我方 / 对手」—— 同一份数据在两边指的是不同的人，存取时得翻一下。
   * 两种口径互为镜像：翻两次正好回到原样。
   */
  function flipFields(f) {
    // 逐项复制：局上除两列招式外还挂着 seg（连续段编号），不能只挑那两列
    f.history = f.history.map((r) => Object.assign({}, r, { human: r.cpu, cpu: r.human }));
    f.stats = { human: f.stats.cpu, cpu: f.stats.human, draw: f.stats.draw };
    const st = f.streak || {};
    f.streak = { side: st.side === 'human' ? 'cpu' : st.side === 'cpu' ? 'human' : null, count: st.count || 0 };
    f.lastResult = f.lastResult === 'human' ? 'cpu' : f.lastResult === 'cpu' ? 'human' : f.lastResult;
    return f;
  }

  /* ============================== 参数 ============================== */

  const readOptions = () => ({
    alpha: Number(els.alphaInput.value),
    exploreScale: Number(els.epsInput.value) / 100,
    explore: els.exploreInput.checked,
    confidence: Number(els.confInput.value),
    halfLife: Number(els.hlInput.value),
  });
  const newPredictor = (N) => new Predictor(N, readOptions());

  /** 当前的参数快照（含自动调参开关） */
  function readParams() {
    return Object.assign(readOptions(), { autoTune: els.autoInput.checked });
  }

  /** 把参数快照写回控件（连同输出文案与锁定状态） */
  function writeParams(p) {
    els.alphaInput.value = String(p.alpha);
    els.epsInput.value = String(Math.round(p.exploreScale * 100));
    els.exploreInput.checked = !!p.explore;
    els.autoInput.checked = !!p.autoTune;
    els.confInput.value = String(p.confidence);
    els.hlInput.value = String(p.halfLife);
    els.alphaOut.textContent = Number(els.alphaInput.value).toFixed(1);
    els.epsOut.textContent = Math.round(Number(els.epsInput.value)) + '%';
    els.confOut.textContent = Number(els.confInput.value).toFixed(1);
    els.hlOut.textContent = Number(els.hlInput.value) + ' 局';
    syncParamDisabled();
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

  // 首次进入某个玩法时用的参数 = 页面初始（HTML 里的默认值）
  const DEFAULT_PARAMS = readParams();

  /* ============================== 档案 ============================== */

  /** 一份干净的档案（新建玩法 / 重置 / 导入缺段时的统一默认值） */
  function emptyProfile() {
    return {
      history: [],
      seg: 0,
      segStart: 0,
      lastAt: 0,
      stats: { cpu: 0, human: 0, draw: 0 },
      hit: 0,
      hitTries: 0,
      hitLog: [],
      ideal: { win: 0, lose: 0 },
      bestLog: [],
      shadow: [],
      shadowTargets: null,
      rateTable: null,
      decayShadow: [],
      decayTargets: null,
      decayRateTable: null,
      exploreStat: null,
      exploreCap: 0,
      predictStat: null,
      predictTrust: 0,
      predictDrop: 0,
      streak: { side: null, count: 0 },
      lastResult: null,
    };
  }

  /** 把一套资料装进当前工作区（p 为 null 就给干净的一份 + 默认参数） */
  function setProfileIntoState(p) {
    Object.assign(state, emptyProfile());
    state.seq = (p && p.seq) || 0;        // 每份数据各自的「最近玩过」序号
    if (p) {
      Object.assign(state, p.fields);
      writeParams(p.params || DEFAULT_PARAMS);   // 存档被手改过（缺 params）时也起得来
    } else {
      writeParams(DEFAULT_PARAMS);
    }
  }

  /** 这个键是不是「有名字」的那一份（`p:名字`）；没名字的默认档（'duel' / 'assist'）不算 */
  const isNamedKey = (key) => typeof key === 'string' && key.indexOf('p:') === 0;

  /** 取某份档案的快照：当前工作区看现场，其余看寄存位 */
  function profileOf(key) {
    if (key === state.key) return { fields: state, params: readParams(), seq: state.seq };
    return parked[key] || null;
  }

  /**
   * 把当前这套寄存起来（切走前调用）；辅助模式的现场要翻成「被预测者在先」再存。
   * 没名字的那份不进档案表 —— 它没有身份，切走就等于丢掉（想留下来就手动导出存档）。
   */
  function parkProfile() {
    if (!isNamedKey(state.key)) return;
    const fields = {};
    for (const k of PROFILE_FIELDS) fields[k] = state[k];
    parked[state.key] = { fields: isAssist() ? flipFields(fields) : fields, params: readParams(), seq: state.seq };
  }

  /**
   * 把某份档案搬进工作区（寄存位随之清空；没存过就是干净的一份 + 默认参数）。
   * 没名字的键不给读（forceRead = 手动导入存档时例外），所以切模式/换名字时它总是从空白开始。
   */
  function takeProfile(key, forceRead) {
    const p = isNamedKey(key) || forceRead ? parked[key] || null : null;
    delete parked[key];
    state.key = key;
    // 档案里是「被预测者在先」，辅助模式的现场要翻回去（对战模式两边口径本来就一致）
    if (p && isAssist()) flipFields(p.fields);
    setProfileIntoState(p);
  }

  /* ============================== 模型 ============================== */

  // 每个半衰期档位维护一份独立模型，同时学习同一份历史，用于比较命中率
  function rebuildDecayModels() {
    app.decayModels = DECAY_TIERS.map((hl) =>
      new Predictor(ORDER, Object.assign(readOptions(), { halfLife: hl }))
    );
    for (const m of app.decayModels) m.replay(predView());
  }

  /**
   * 把主模型的当前参数同步给各半衰期档位模型。
   * 这些模型只在「建模型那一刻」抓过一次参数，而主模型的 α / 样本收缩 / 探索强度会被
   * 自动调参逐局改动 —— 不同步的话，面板上比的就不是「同一套参数下谁记性更好」，
   * 而是「两套不同参数的模型谁碰巧更准」，结论没有意义。
   * @param replay 是否需要回放历史（α 变了就必须，它会改变各标准的平滑程度）
   */
  function syncDecayModels(replay) {
    const o = readOptions();
    for (const m of app.decayModels) {
      m.options.alpha = o.alpha;
      m.options.confidence = o.confidence;
      m.options.explore = o.explore;
      m.options.exploreScale = o.exploreScale;   // halfLife 各自保留档位值，不覆盖
      if (replay) m.replay(predView());
    }
  }

  /* ============================== 导出 ============================== */

  const app = {
    // 常量
    ORDER, ROUND_GAP_MS, MODE_LABEL, Z_CANDIDATES, Z_WINDOW, Z_MIN_SAMPLES, HL, DECAY_TIERS, EXPLORE_TIERS,
    SAVE_FORMAT, SAVE_VERSION, PROFILE_FIELDS,
    // DOM 与状态
    $, els, state, parked,
    predictor: newPredictor(ORDER),
    decayModels: [],
    panelSort: 'weight',
    // 文本 / 称谓
    isAssist, tx, predView, meName, oppName,
    // 档案身份
    NAME_MAX, cleanName, predictedName, profileKey, currentKey, knownNames, isNamedKey, flipFields, bumpActivity,
    // 参数
    readOptions, readParams, writeParams, syncParamDisabled, newPredictor, DEFAULT_PARAMS,
    // 档案
    emptyProfile, setProfileIntoState, profileOf, parkProfile, takeProfile, flipFields,
    // 模型
    rebuildDecayModels, syncDecayModels,
  };

  global.RPSApp = app;
})(window);
