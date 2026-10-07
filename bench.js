/*!
 * RPS-AI · 基准测试
 *
 * 在合成对手与固定随机种子上跑完整的对局流程，输出 AI 的预测命中率与胜率 —— 用来回答
 * 「这次算法改动究竟变好了还是变坏了」。载入的就是页面实际使用的那几个模块，不需要浏览器。
 *
 * 用法：
 *   node bench.js
 *   node bench.js --save base.json
 *   node bench.js --predictor js/predictor2.js --compare base.json
 *
 * 选项：
 *   --games N       每个对手、每个种子的对局数（默认 400）
 *   --seeds N       随机种子个数，各轮结果按总局数合并（默认 4）
 *   --core F        基础库（默认 js/core.js）
 *   --predictor F   预测核心（默认 js/predictor.js）
 *   --module F      额外载入的应用层模块，可重复（默认 js/app/context.js、js/app/autotune.js）
 *   --order N       记忆阶数（默认 与页面一致，即 3）；用于比较「单阶」与「多阶合成」
 *   --label S       本次结果的名称（默认取预测核心的路径）
 *   --save F        把结果写入 JSON 文件，留作以后的基线
 *   --compare F     与已有的基线 JSON 逐项比对
 *   --json          以 JSON 打印结果
 *
 * 说明：
 *   · 随机源被替换为可播种的伪随机，所以「同一种子跑两次」结果完全一致；
 *     同一版本换种子仍有小幅波动，判断改动是否有效应看多数对手是否同向变化。
 *   · 合成对手只是固定的陪练，用于横向比较，不追求逼近真人。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SEED_BASE = 20261007;
const DEFAULT_MODULES = ['js/app/context.js', 'js/app/autotune.js'];

/* ============================== 选项 ============================== */

function parseArgs(argv) {
  const opt = {
    games: 400,
    seeds: 4,
    core: 'js/core.js',
    predictor: 'js/predictor.js',
    modules: DEFAULT_MODULES,
    order: null,
    label: null,
    save: null,
    compare: null,
    json: false,
  };
  let modulesGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(a + ' 缺少取值');
      return argv[i];
    };
    if (a === '--help' || a === '-h') return null;
    else if (a === '--games') opt.games = Math.max(1, Number(next()) | 0);
    else if (a === '--seeds') opt.seeds = Math.max(1, Number(next()) | 0);
    else if (a === '--core') opt.core = next();
    else if (a === '--predictor') opt.predictor = next();
    else if (a === '--module') {
      if (!modulesGiven) { opt.modules = []; modulesGiven = true; }
      opt.modules.push(next());
    } else if (a === '--order') opt.order = Math.max(1, Number(next()) | 0);
    else if (a === '--label') opt.label = next();
    else if (a === '--save') opt.save = next();
    else if (a === '--compare') opt.compare = next();
    else if (a === '--json') opt.json = true;
    else throw new Error('未知选项：' + a);
  }
  return opt;
}

/* ============================== 确定性随机 ============================== */

/** mulberry32：短小且分布均匀，足以驱动整轮跑分 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** 顶替沙箱里的 crypto：核心库的 randFloat / randInt 会转而取这里的字节 */
function fakeCrypto(next) {
  return {
    getRandomValues(buf) {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
      return buf;
    },
  };
}

/* ============================== 假 DOM ============================== */

// 与 index.html 里的初始值一致：context.js 会在载入时读它们作为默认参数
const EL_DEFAULTS = {
  autoInput: { checked: true },
  exploreInput: { checked: true },
  alphaInput: { value: '1' },
  confInput: { value: '1' },
  hlInput: { value: '16' },
  epsInput: { value: '10' },
};

function makeElement(id) {
  const d = EL_DEFAULTS[id] || {};
  return {
    id,
    value: d.value == null ? '' : d.value,
    checked: !!d.checked,
    textContent: '',
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
}

/* ============================== 载入前端代码 ============================== */

/** 建一个隔离的沙箱，按页面相同的顺序载入模块；返回该沙箱 */
function loadSandbox(opt, seed) {
  const els = new Map();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.crypto = fakeCrypto(mulberry32(seed));
  sandbox.document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
  };
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.createContext(sandbox);

  for (const f of [opt.core, opt.predictor].concat(opt.modules)) {
    const file = path.resolve(ROOT, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

/* ============================== 合成对手 ============================== */

/** 从概率分布里取一招 */
function sampleMix(mix, rnd) {
  let r = rnd();
  for (let i = 0; i < 3; i++) {
    r -= mix[i];
    if (r < 0) return ['R', 'P', 'S'][i];
  }
  return 'S';
}

// 一阶惯性：上一招为 R / P / S 时，下一招取 R、P、S 的概率
const MARKOV = {
  R: [0.45, 0.2, 0.35],
  P: [0.25, 0.45, 0.3],
  S: [0.3, 0.25, 0.45],
};

const OPPONENTS = [
  {
    id: 'random',
    name: '纯随机',
    desc: '三招等概率，不看任何信息',
    pick: (view, rnd, api) => api.pickUniform(rnd),
  },
  {
    id: 'cycle',
    name: '固定循环',
    desc: '石头、布、剪刀依次循环',
    pick: (view) => ['R', 'P', 'S'][view.length % 3],
  },
  {
    id: 'repeat',
    name: '惯性重复',
    desc: '75% 沿用上一招，其余随机',
    pick: (view, rnd, api) =>
      view.length && rnd() < 0.75 ? view[view.length - 1].human : api.pickUniform(rnd),
  },
  {
    id: 'winStay',
    name: '赢了就重复',
    desc: '上局赢则沿用该招，否则从另外两招里随机换一个',
    pick: (view, rnd, api) => {
      if (!view.length) return api.pickUniform(rnd);
      const last = view[view.length - 1];
      if (api.judge(last.human, last.cpu) === 'human') return last.human;
      const rest = api.MOVES.filter((m) => m !== last.human);
      return rest[Math.floor(rnd() * rest.length)];
    },
  },
  {
    id: 'counterCpu',
    name: '反制电脑上一招',
    desc: '出能击败电脑上一招的招',
    pick: (view, rnd, api) =>
      view.length ? api.COUNTER[view[view.length - 1].cpu] : api.pickUniform(rnd),
  },
  {
    id: 'markov',
    name: '一阶惯性',
    desc: '按固定的转移概率决定下一招',
    pick: (view, rnd, api) =>
      view.length ? sampleMix(MARKOV[view[view.length - 1].human], rnd) : api.pickUniform(rnd),
  },
];

/* ============================== 跑一个对手 ============================== */

/**
 * 跑一位合成对手的整轮对局。流程与 js/app/main.js 的 startRound + settle 同口径：
 * 每局先按命中记录更新押注概率，再决策、出招、学习，最后走一遍在线调参。
 */
function runOpponent(sandbox, opp, seed, games, order) {
  const app = sandbox.RPSApp;
  const RPS = sandbox.RPS;
  const state = app.state;
  const els = app.els;
  const raw = mulberry32(seed ^ 0x9e3779b9);   // 对手侧独立的随机流
  const rnd = () => raw() / 4294967296;        // 取 [0,1) 浮点，供对手策略使用
  const api = {
    MOVES: RPS.MOVES,
    COUNTER: RPS.COUNTER,
    judge: RPS.judge,
    pickUniform: (r) => RPS.MOVES[Math.floor(r() * 3)],
  };

  // 参数回到页面初始值，再重建模型与统计，确保各轮之间互不影响
  els.autoInput.checked = true;
  els.exploreInput.checked = true;
  els.alphaInput.value = '1';
  els.confInput.value = '1';
  els.hlInput.value = '16';
  els.epsInput.value = '10';
  Object.assign(state, app.emptyProfile());
  app.predictor = app.newPredictor(order || app.ORDER);
  app.rebuildDecayModels();

  const out = { games, hits: 0, win: 0, lose: 0, draw: 0, idealWin: 0, idealLose: 0 };
  const keep = app.Z_WINDOW * 3;

  for (let g = 0; g < games; g++) {
    app.syncPredictTrust();
    const view = app.predView();
    const d = app.predictor.decide(view);
    // 影子：各收缩档位与各记忆半衰期档位在同一局面下的预测招（在线调参要用）
    const shadowTargets = app.Z_CANDIDATES.map((z) => app.predictor.decide(view, z).target);
    const decayTargets = app.decayModels.map((m) => m.decide(view).target);

    const humanMove = opp.pick(view, rnd, api);
    const cpuMove = d.cpuMove;
    const hit = d.target === humanMove;
    const res = RPS.judge(humanMove, cpuMove);
    const idealRes = RPS.judge(humanMove, d.bestCpu);

    out.hits += hit ? 1 : 0;
    if (res === 'cpu') out.win++;
    else if (res === 'human') out.lose++;
    else out.draw++;
    if (idealRes === 'cpu') out.idealWin++;
    else if (idealRes === 'human') out.idealLose++;

    const bestWon = idealRes === 'cpu';
    const bestLost = idealRes === 'human';
    state.hitTries++;
    if (hit) state.hit++;
    state.hitLog.push(hit ? 1 : 0);
    state.shadow.push(shadowTargets.map((t) => (t === humanMove ? 1 : 0)));
    state.decayShadow.push(decayTargets.map((t) => (t === humanMove ? 1 : 0)));
    state.stats[res]++;
    if (bestWon) state.ideal.win++;
    else if (bestLost) state.ideal.lose++;
    state.bestLog.push(bestWon ? 'cpu' : bestLost ? 'human' : 'draw');

    if (state.hitLog.length > 5000) state.hitLog.splice(0, state.hitLog.length - 5000);
    for (const log of [state.shadow, state.decayShadow, state.bestLog]) {
      if (log.length > keep) log.splice(0, log.length - keep);
    }

    // 顺序与 settle 一致：先学习（此时历史不含本局），再把本局入库
    app.predictor.learn(view, humanMove);
    for (const m of app.decayModels) m.learn(view, humanMove);
    state.history.push({ human: humanMove, cpu: cpuMove });

    app.autoTuneStep();
  }
  return out;
}

/* ============================== 汇总 ============================== */

function bench(opt) {
  const rows = [];
  for (const opp of OPPONENTS) {
    const agg = { id: opp.id, name: opp.name, desc: opp.desc, games: 0, hits: 0, win: 0, lose: 0, draw: 0, idealWin: 0, idealLose: 0 };
    for (let s = 0; s < opt.seeds; s++) {
      const seed = SEED_BASE + s;
      const r = runOpponent(loadSandbox(opt, seed), opp, seed, opt.games, opt.order);
      for (const k of ['games', 'hits', 'win', 'lose', 'draw', 'idealWin', 'idealLose']) agg[k] += r[k];
    }
    rows.push(agg);
  }
  return rows;
}

/** 全部对手合起来的总计 */
function sumRows(rows) {
  const tot = { games: 0, hits: 0, win: 0, lose: 0, draw: 0, idealWin: 0, idealLose: 0 };
  for (const r of rows) for (const k of Object.keys(tot)) tot[k] += r[k];
  return tot;
}

const rate = (r) => ({
  hit: r.games ? r.hits / r.games : 0,
  win: r.games ? r.win / r.games : 0,
  ideal: r.games ? r.idealWin / r.games : 0,
});

/* ============================== 输出 ============================== */

const wideLen = (s) => {
  let n = 0;
  for (const ch of String(s)) n += ch.charCodeAt(0) > 0x1100 ? 2 : 1;
  return n;
};
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - wideLen(s)));
const pct = (x) => (x * 100).toFixed(2) + '%';
const diff = (x) => (x >= 0 ? '+' : '-') + Math.abs(x * 100).toFixed(2);

const W = 16;
const C = 11;

function printTable(rows, base) {
  const tot = rate(sumRows(rows));
  if (!base) {
    console.log(pad('对手', W) + pad('命中率', C) + pad('偏离基准', C) + pad('AI 胜率', C) + pad('按最优出招', C));
    for (const r of rows) {
      const t = rate(r);
      console.log(pad(r.name, W) + pad(pct(t.hit), C) + pad(diff(t.hit - 1 / 3), C) + pad(pct(t.win), C) + pad(pct(t.ideal), C));
    }
    console.log('-'.repeat(W + C * 4));
    console.log(pad('合计', W) + pad(pct(tot.hit), C) + pad(diff(tot.hit - 1 / 3), C) + pad(pct(tot.win), C) + pad(pct(tot.ideal), C));
    console.log('');
    console.log('命中率 = AI 预测被预测者下一招的命中率（随机基准 33.33%）；AI 胜率 = AI 作为一方的胜率。');
    return;
  }

  const pick = (id) => rate(base.rows.find((r) => r.id === id) || { games: 0 });
  const D = 10;
  const line = (name, a, b) =>
    pad(name, W) + pad(pct(a.hit), D) + pad(pct(b.hit), D) + pad(diff(b.hit - a.hit), D) +
    pad(pct(a.win), D) + pad(pct(b.win), D) + pad(diff(b.win - a.win), D);

  console.log('基线：' + base.label + '（' + base.games + ' 局/对手 × ' + base.seeds + ' 种子）');
  console.log('本次：' + (base.currentLabel || ''));
  console.log('');
  console.log(pad('对手', W) + pad('命中率', D * 3) + pad('AI 胜率', D * 3));
  console.log(pad('', W) + pad('基线', D) + pad('本次', D) + pad('差', D) + pad('基线', D) + pad('本次', D) + pad('差', D));
  for (const r of rows) console.log(line(r.name, pick(r.id), rate(r)));
  const bt = rate(base.total);
  console.log('-'.repeat(W + D * 6));
  console.log(line('合计', bt, tot));
  console.log('');
  console.log('「差」为本次减基线，单位为百分点；正数表示本次更高。');
}

/* ============================== 主流程 ============================== */

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('用 --help 查看用法。');
    process.exit(2);
  }
  if (!opt) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*!?/, '').replace(/^ ?\* ?/gm, '').trim());
    return;
  }

  const label = opt.label || opt.predictor;
  const rows = bench(opt);
  const total = sumRows(rows);

  let base = null;
  if (opt.compare) base = JSON.parse(fs.readFileSync(path.resolve(ROOT, opt.compare), 'utf8'));

  if (opt.json) {
    console.log(JSON.stringify({ label, games: opt.games, seeds: opt.seeds, rows, total }, null, 2));
  } else {
    console.log('RPS-AI 基准测试 · ' + label);
    console.log('记忆阶数：' + (opt.order || '页面默认（3）'));
    console.log('每个对手 ' + opt.games + ' 局 × ' + opt.seeds + ' 个种子 = ' + opt.games * opt.seeds + ' 局');
    console.log('');
    if (base) base.currentLabel = label;
    printTable(rows, base);
  }

  if (opt.save) {
    const out = { label, games: opt.games, seeds: opt.seeds, rows, total };
    fs.writeFileSync(path.resolve(ROOT, opt.save), JSON.stringify(out, null, 2) + '\n');
    console.log('');
    console.log('已写入基线：' + opt.save);
  }
}

main();
