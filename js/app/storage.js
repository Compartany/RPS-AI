/*!
 * RPS-AI · 存档序列化
 *
 * 存档用 JSON（自描述、字段可增删）：
 *   { format, version, order, mode, user?, opponent?, profiles: { 档案键: 段, … } }
 *   档案键按「被预测者」分：`p:名字`（这个人在两种玩法下的记录合在一份），
 *   没起名字时退回模式默认档：'duel'（对战）/ 'assist'（辅助）。
 *   user / opponent 只是当前界面的状态（名字框里填了什么），没填就不写。
 *   「段」= { params{…}, stats{…}, hit, hitTries, ideal{…}, history, breaks, lastAt, hitLog }
 *   history 是紧凑串（每局 2 字符：被预测者 + 对方），hitLog 每局 1 字符。
 *   breaks 是连续段的断点（局号）：从该局起另起一段，两端的局不拼成同一条序列 ——
 *   很久没玩之后再回来，当前局的序列不跨过断点去借旧局的招；lastAt 是上一局的时间戳，
 *   供下次启动判定「隔了多久」。两者缺失（旧存档 / 手改过）都当「整条历史是一段」。
 *
 * 跨版本兼容就靠一条：读的时候只认自己认识的字段 ——
 * 缺的用默认值补上、多的直接忽略，所以新版存档丢给旧版、旧版丢给新版都能读。
 * 键也同理：只认识上面几种（V4 的 'assist#名字' 等同于 `p:名字`），其余的丢掉。
 *
 * 自动存档（autosave）用的是同一套格式，只在 localStorage 里加了两个自己的字段：
 *   active：上次的当前档案键（无名档时写 null）—— 没有它，恢复时只能按「模式 + 名字」猜，
 *          猜不到就会把别人的档案装成当前档；
 *   profiles 里只留有名字的档案（'duel' / 'assist' 这种无名档不进自动存档）。
 */
(function (global) {
  'use strict';

  const App = global.RPSApp;
  const { state } = App;
  const { MOVES } = global.RPS;

  /**
   * 把当前状态（每份档案各自的快照）序列化成存档文本
   * @param opt.namedOnly 只收「有名字」的档案（自动存档用：没名字的那份按口径本来就不该留下来）
   */
  function buildSave(opt) {
    const seg = (key) => {
      const p = App.profileOf(key);
      if (!p) return null;                     // 该档案没启用过：不留段
      // 存档统一按「被预测者在先」写：寄存位里的档案本来就是这个口径，但当前档拿到的
      // 是现场 —— 辅助模式的现场是「我方在先」，得翻一份副本再写（与 takeProfile 读回时
      // 的翻动对称，否则导出与导入对不上，两列会互换）。
      let f = p.fields;
      if (key === state.key && App.isAssist()) {
        f = {};
        for (const k of App.PROFILE_FIELDS) f[k] = state[k];
        App.flipFields(f);
      }
      const pr = p.params;
      return {
        params: {
          alpha: pr.alpha,
          exploreScale: pr.exploreScale,
          explore: !!pr.explore,
          autoTune: !!pr.autoTune,
          confidence: pr.confidence,
          halfLife: pr.halfLife,
        },
        stats: { cpu: f.stats.cpu | 0, human: f.stats.human | 0, draw: f.stats.draw | 0 },
        hit: f.hit | 0,
        hitTries: f.hitTries | 0,
        ideal: { win: f.ideal.win | 0, lose: f.ideal.lose | 0 },
        history: f.history.map((r) => r.human + r.cpu).join(''),
        breaks: breaksOf(f.history),
        lastAt: f.lastAt || undefined,
        hitLog: (f.hitLog || []).join(''),
      };
    };
    // 键就是档案键（见文件头）；当前那份排在最前，其余按寄存位里的顺序
    const profiles = {};
    for (const key of [state.key, ...Object.keys(App.parked)]) {
      if (profiles[key] !== undefined) continue;
      if (opt && opt.namedOnly && !/^p:/.test(key)) continue;
      const s = seg(key);
      if (s) profiles[key] = s;
    }
    return JSON.stringify({
      format: App.SAVE_FORMAT,
      version: App.SAVE_VERSION,
      order: App.ORDER,
      mode: state.mode,
      // 没改名字就不写这两个字段 —— 存档里也就不含「谁是谁」的信息
      user: state.userName || undefined,
      opponent: state.opponent || undefined,
      profiles,
    }, null, 2) + '\n';
  }

  /** 局上的段标记 → 断点局号（第 i 局与第 i-1 局不同段）；没有断点返回 undefined，存档里就不写这个字段 */
  function breaksOf(history) {
    const out = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i].seg !== history[i - 1].seg) out.push(i);
    }
    return out.length ? out : undefined;
  }

  /** 读一个 JSON 段；字段缺失、类型不对都退回默认值（这就是跨版本兼容的关键） */
  function profileFromJSON(o) {
    if (!o || typeof o !== 'object') return null;
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const hist = typeof o.history === 'string' ? o.history : '';
    const ok = (c) => MOVES.indexOf(c) >= 0;
    const history = [];
    for (let i = 0; i + 1 < hist.length; i += 2) {
      if (ok(hist[i]) && ok(hist[i + 1])) history.push({ human: hist[i], cpu: hist[i + 1] });
    }
    // 按断点给每局标上「连续段」编号（缺字段 = 整条历史一段，与旧行为一致）
    const breaks = new Set();
    if (Array.isArray(o.breaks)) {
      for (const v of o.breaks) {
        if (typeof v === 'number' && v > 0 && v < history.length) breaks.add(v | 0);
      }
    }
    let seg = 0;
    let segStart = 0;
    for (let i = 0; i < history.length; i++) {
      if (i > 0 && breaks.has(i)) { seg++; segStart = i; }
      history[i].seg = seg;
    }
    const p = o.params || {};
    const st = o.stats || {};
    const id = o.ideal || {};
    return {
      params: {
        alpha: num(p.alpha, 1),
        exploreScale: num(p.exploreScale, 0),
        explore: bool(p.explore, true),
        autoTune: bool(p.autoTune, true),
        confidence: num(p.confidence, 1),
        halfLife: num(p.halfLife, 16),
      },
      fields: {
        history,
        seg,
        segStart,
        lastAt: num(o.lastAt, 0),
        stats: { cpu: num(st.cpu, 0) | 0, human: num(st.human, 0) | 0, draw: num(st.draw, 0) | 0 },
        hit: num(o.hit, 0) | 0,
        hitTries: num(o.hitTries, 0) | 0,
        hitLog: typeof o.hitLog === 'string'
          ? o.hitLog.split('').map((c) => (c === '1' ? 1 : 0)).slice(-5000)
          : [],
        ideal: { win: num(id.win, 0) | 0, lose: num(id.lose, 0) | 0 },
      },
    };
  }

  /** 规范化档案键：`p:名字` / 'duel' / 'assist'；V4 的 'assist#名字' 等同于 `p:名字`，认不出的丢掉 */
  function normKey(k) {
    if (k === 'duel' || k === 'assist') return k;
    if (typeof k !== 'string') return null;
    if (k.indexOf('p:') === 0) {
      const n = App.cleanName(k.slice(2));
      return n ? 'p:' + n : null;
    }
    if (k.indexOf('assist#') === 0) {          // V4 旧键：辅助模式下某人的档案
      const n = App.cleanName(k.slice('assist#'.length));
      return n ? 'p:' + n : 'assist';
    }
    return null;
  }

  /** 解析存档文本：只认 JSON（字段可增删，见文件头注释） */
  function parseSave(text) {
    const s = String(text).replace(/^\uFEFF/, '').trim();   // 容忍 BOM 与前后空白
    let d;
    try {
      d = JSON.parse(s);
    } catch (e) {
      throw new Error('存档内容不是合法的 JSON');
    }
    if (!d || typeof d !== 'object') throw new Error('存档内容不是有效的 JSON 对象');
    const raw = d.profiles || {};
    const profiles = {};
    for (const k of Object.keys(raw)) {
      const key = normKey(k);
      if (!key || !raw[k]) continue;
      profiles[key] = profileFromJSON(raw[k]);
    }
    if (!Object.keys(profiles).length) throw new Error('存档里没有任何数据段');
    const mode = d.mode === 'assist' ? 'assist' : 'duel';
    const user = App.cleanName(d.user);
    const opponent = App.cleanName(d.opponent);
    // 当前该打开哪一份：按存档里的「模式 + 名字」算；算出来没有（手改过 / 跨版本）就退回同模式的默认档
    let key = App.profileKey(mode, user, opponent);
    if (!profiles[key]) {
      const fallback = mode === 'assist' ? 'assist' : 'duel';
      key = profiles[fallback] ? fallback : Object.keys(profiles)[0];
    }
    return { key, profiles, mode, user, opponent };
  }

  /* ============================== 自动存档 ============================== */

  const AUTOSAVE_KEY = 'rps-ai-autosave';

  /**
   * 自动存档：把进展写进 localStorage，刷新 / 关掉页面再回来还能接着玩。
   * 只收有名字的档案（无名档按本项目口径本来就不该留下来），另外记下当前档是谁 ——
   * 恢复时不能靠「模式 + 名字」去猜：上次若是无名档，猜出来会把别人的档案装成当前档。
   * 全程吞异常：file:// 或隐私设置禁掉 localStorage 时，静默退化成「和以前一样只在内存里」。
   */
  function autosave() {
    try {
      const d = JSON.parse(buildSave({ namedOnly: true }));
      if (!Object.keys(d.profiles).length) {          // 全删光了：存档也一并清掉
        localStorage.removeItem(AUTOSAVE_KEY);
        return;
      }
      d.active = /^p:/.test(state.key) ? state.key : null;
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(d));
    } catch (e) { /* 存不了就算了，不该影响正事 */ }
  }

  /** 读回自动存档：没有 / 坏了 / 被禁用都返回 null。返回 { data, active }（active 为 undefined 表示这份存档没记过当前档） */
  function loadAutosave() {
    try {
      const text = localStorage.getItem(AUTOSAVE_KEY);
      if (!text) return null;
      const raw = JSON.parse(text);
      // active 可能是字符串（有名字的档）或 null（上次那份没名字）；只有「压根没这个字段」才当没记过 ——
      // 不这么分的话，null 会被 typeof 判成 object 而丢掉，恢复时又退回「按名字算」，把别人的档装成当前档。
      const active = 'active' in raw ? (typeof raw.active === 'string' ? raw.active : null) : undefined;
      return { data: parseSave(text), active };
    } catch (e) { return null; }
  }

  Object.assign(App, { buildSave, parseSave, autosave, loadAutosave });
})(window);
