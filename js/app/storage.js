/*!
 * RPS-AI · 存档序列化
 *
 * 存档用 JSON（自描述、字段可增删）：
 *   { format, version, order, mode, profiles: { duel: 段, assist: 段 } }
 *   「段」= { params{…}, stats{…}, hit, hitTries, ideal{…}, history, hitLog }
 *   history 是紧凑串（每局 2 字符：我方 + 对手），hitLog 每局 1 字符。
 *
 * 跨版本兼容就靠一条：读的时候只认自己认识的字段 ——
 * 缺的用默认值补上、多的直接忽略，所以新版存档丢给旧版、旧版丢给新版都能读。
 */
(function (global) {
  'use strict';

  const App = global.RPSApp;
  const { state } = App;
  const { MOVES } = global.RPS;

  /** 把当前状态（两套玩法各自的快照）序列化成存档文本 */
  function buildSave() {
    const seg = (mode) => {
      const p = App.profileOf(mode);
      if (!p) return null;                     // 该玩法没启用过：不留段
      const f = p.fields;
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
        hitLog: (f.hitLog || []).join(''),
      };
    };
    return JSON.stringify({
      format: App.SAVE_FORMAT,
      version: App.SAVE_VERSION,
      order: App.ORDER,
      mode: state.mode,
      profiles: { duel: seg('duel'), assist: seg('assist') },
    }, null, 2) + '\n';
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
    const profs = d.profiles || {};
    return {
      order: Number(d.order) || 3,
      mode: d.mode === 'assist' ? 'assist' : 'duel',
      profiles: { duel: profileFromJSON(profs.duel), assist: profileFromJSON(profs.assist) },
    };
  }

  Object.assign(App, { buildSave, parseSave });
})(window);
