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

  const MODE_LABEL = { duel: '对战模式', assist: '辅助模式' };

  // 自动调参：候选的样本收缩档位（0 = 完全按应验率加权）、评估窗口与最少样本
  const Z_CANDIDATES = [0, 0.5, 1, 1.5, 2];
  const Z_WINDOW = 40;
  const Z_MIN_SAMPLES = 12;
  // 记忆衰减档位（半衰期，局），取 2 的幂便于按对数均匀覆盖；0 = 不遗忘
  const DECAY_TIERS = [0, 64, 32, 16, 8];
  // 探索强度档位（保底纯随机概率），从低到高；自动调参在此之间按电脑胜率择优
  const EXPLORE_TIERS = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 1];

  const SAVE_FORMAT = 'rps-ai-save';
  const SAVE_VERSION = 3;

  // 每种玩法各自寄存的累积字段 —— 局内的（pending / revealed / picks …）每局都会重来，不必存
  const PROFILE_FIELDS = [
    'history', 'stats', 'hit', 'hitTries', 'hitLog', 'ideal', 'bestLog',
    'shadow', 'shadowTargets', 'rateTable',
    'decayShadow', 'decayTargets', 'decayRateTable',
    'exploreStat', 'exploreCap', 'predictStat', 'predictTrust',
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
    mode: 'duel',                      // 'duel' 对战模式 | 'assist' 辅助模式
    picks: { opp: null, me: null },    // 辅助模式：本局补录的对手出招（我方出招默认 AI 推荐，可改选）
    revealedOpp: null,                 // 本局对手的实际出招（揭示时展示）
  };

  // 不在用的那一套（null = 还没启用过）
  const parked = { duel: null, assist: null };

  /* ============================== 文本 / 称谓 ============================== */

  const isAssist = () => state.mode === 'assist';

  /**
   * 两种模式下「我方（human 字段）」与「对手（cpu 字段）」的称呼：
   *   duel   —— 我方 = 你；对手 = 电脑（AI）
   *   assist —— 我方 = 我方；对手 = 对手（真人，不再叫「电脑」）
   * 说明文案统一按 duel 的口径写（「你」= 被预测者、「电脑」= cpu 字段那侧），
   * 切到辅助模式时用 tx() 把角色词换掉；另外「人类」在辅助模式下改称「对手」。
   */
  function tx(s) {
    if (!isAssist()) return s;
    return String(s)
      .split('电脑').join('\u0001')   // 先占位，避免与「你」的替换相互干扰
      .split('人类').join('对手')
      .split('你').join('对手')
      .split('\u0001').join('我方');
  }

  /** 预测器视图：把「被预测者」放进 human 字段（预测器只区分 human / cpu 两列） */
  function predView() {
    return isAssist()
      ? state.history.map((r) => ({ human: r.cpu, cpu: r.human }))
      : state.history;
  }

  /** 我方（human 字段一方）的称谓：对战模式是「你」，辅助模式是「我方」 */
  const meName = () => (isAssist() ? '我方' : '你');

  /** 对手（cpu 字段一方）的称谓：对战模式是「电脑」，辅助模式是「对手」（真人） */
  const oppName = () => (isAssist() ? '对手' : '电脑');

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
    els.hlOut.textContent = Number(els.hlInput.value) > 0 ? Number(els.hlInput.value) + ' 局' : '不遗忘';
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
      streak: { side: null, count: 0 },
      lastResult: null,
    };
  }

  /** 把一套资料装进当前工作区（p 为 null 就给干净的一份 + 默认参数） */
  function setProfileIntoState(p) {
    Object.assign(state, emptyProfile());
    if (p) {
      Object.assign(state, p.fields);
      writeParams(p.params);
    } else {
      writeParams(DEFAULT_PARAMS);
    }
  }

  /** 取某个玩法的快照：当前模式看现场，另一个看寄存位 */
  function profileOf(mode) {
    if (mode === state.mode) return { fields: state, params: readParams() };
    return parked[mode];
  }

  /** 把当前这套寄存起来（切走前调用） */
  function parkProfile() {
    const fields = {};
    for (const k of PROFILE_FIELDS) fields[k] = state[k];
    parked[state.mode] = { fields, params: readParams() };
  }

  /** 把某个玩法那套搬进工作区（寄存位随之清空；没存过就是干净的一份） */
  function takeProfile(mode) {
    const p = parked[mode] || null;
    parked[mode] = null;
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

  /* ============================== 导出 ============================== */

  const app = {
    // 常量
    ORDER, MODE_LABEL, Z_CANDIDATES, Z_WINDOW, Z_MIN_SAMPLES, DECAY_TIERS, EXPLORE_TIERS,
    SAVE_FORMAT, SAVE_VERSION, PROFILE_FIELDS,
    // DOM 与状态
    $, els, state, parked,
    predictor: newPredictor(ORDER),
    decayModels: [],
    panelSort: 'weight',
    // 文本 / 称谓
    isAssist, tx, predView, meName, oppName,
    // 参数
    readOptions, readParams, writeParams, syncParamDisabled, newPredictor, DEFAULT_PARAMS,
    // 档案
    emptyProfile, setProfileIntoState, profileOf, parkProfile, takeProfile,
    // 模型
    rebuildDecayModels,
  };

  global.RPSApp = app;
})(window);
