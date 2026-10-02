/*!
 * RPS-Duel · NIST SP 800-22 随机性检测套件
 *
 * 把「人类出招序列」按 2 比特/符号编码成比特流（NIST 文档对 k 进制输入的推荐做法：
 * m = ⌈log2 k⌉ = 2），再跑完整的 15 项统计检验。
 * 编码：✊ = 00，✋ = 01，✌ = 11（码字 10 不出现；这样单比特 0/1 恰好各占一半）。
 */
(function () {
  'use strict';

  /* ============================== 数值工具 ============================== */

  const EPS = 1e-14;
  const FPMIN = 1e-300;

  /** 对数伽马函数（Lanczos 近似） */
  function lgamma(x) {
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /** 下不完全伽马 P(a,x)：级数展开 */
  function gser(a, x) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 1; i <= 500; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }

  /** 上不完全伽马 Q(a,x)：连分式展开 */
  function gcf(a, x) {
    let b = x + 1 - a;
    let c = 1 / FPMIN;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i <= 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  }

  /** 正则化上不完全伽马函数 Q(a,x)（卡方分布的生存函数） */
  function igamc(a, x) {
    if (!(a > 0)) return NaN;
    if (x <= 0) return 1;   // x = 0（或极小样本下统计量偶发为负）时视为完全不显著
    return x < a + 1 ? 1 - gser(a, x) : gcf(a, x);
  }

  /** 互补误差函数 */
  function erfc(x) {
    if (x < 0) return 2 - erfc(-x);
    return igamc(0.5, x * x);
  }

  const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

  /** 固定种子 PRNG（蒙特卡洛标定用） */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randBits(n, rnd) {
    const b = new Array(n);
    for (let i = 0; i < n; i++) b[i] = rnd() < 0.5 ? 0 : 1;
    return b;
  }

  /* ============================== 参数档位 ============================== */

  /**
   * 从最标准（最大）的档位往下试，返回第一个满足 need(t) ≤ n 的；
   * 若全不满足则退回最小档——配合零分布标定仍能给出有意义的结果。
   */
  function pickTier(tiers, n, need) {
    for (const t of tiers) if (n >= need(t)) return t;
    return tiers[tiers.length - 1];
  }

  /** 各检验的参数档位与各自的样本量要求 */
  const TIERS = {
    block: { list: [128, 64, 32, 16, 8], need: (M) => M * 8 },                        // 块长，至少 8 块
    rank: { list: [32, 16, 8, 4, 3, 2], need: (m) => m * m * (m >= 32 ? 38 : 8) },    // 矩阵阶数
    longest: {
      list: [10000, 128, 8],
      // 三套参数表各自的推荐样本量：M=10000 需 ≥ 10⁶、M=128 需 ≥ 6272、M=8 需 ≥ 128
      need: (M) => (M === 10000 ? 750000 : M === 128 ? 6272 : 128),
    },
    lc: { list: [5000, 1000, 500, 250, 125, 62, 31, 16], need: (M) => M * 8 },         // 线性复杂度块长
    universal: { list: [6, 5, 4, 3, 2], need: (L) => (10 * Math.pow(2, L) + 8) * L },  // Maurer 的 L
    template: { list: [8, 7, 6, 5, 4, 3, 2], need: (m) => Math.pow(2, m) * 5 },        // 模板长度
  };

  /** 按长度生成 4 个代表性模板 */
  function makeTemplates(m) {
    return [
      new Array(m).fill(0),
      new Array(m).fill(1),
      Array.from({ length: m }, (_, i) => i % 2),
      Array.from({ length: m }, (_, i) => (i === m - 1 ? 1 : 0)),
    ];
  }

  /** 迭代 FFT（基 2，原地）；N 必须是 2 的幂 */
  function fft(re, im) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < N; i += len) {
        let cwr = 1;
        let cwi = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j;
          const b = a + half;
          const vr = re[b] * cwr - im[b] * cwi;
          const vi = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  /** 离散傅里叶变换幅度（零填充到 2 的幂后走 FFT，取前 n/2 个频率） */
  function dftMag(x) {
    const n = x.length;
    let N = 1;
    while (N < n) N <<= 1;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < n; i++) re[i] = x[i];
    fft(re, im);
    const half = n >> 1;
    const out = new Float64Array(half);
    for (let k = 0; k < half; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return out;
  }

  /** GF(2) 上矩阵的秩 */
  function gf2Rank(rows, nRows, nCols) {
    const m = rows.map((r) => Array.from(r));
    let rank = 0;
    for (let c = 0; c < nCols && rank < nRows; c++) {
      let piv = -1;
      for (let r = rank; r < nRows; r++) if (m[r][c]) { piv = r; break; }
      if (piv < 0) continue;
      const tmp = m[rank];
      m[rank] = m[piv];
      m[piv] = tmp;
      for (let r = 0; r < nRows; r++) {
        if (r !== rank && m[r][c]) for (let j = c; j < nCols; j++) m[r][j] ^= m[rank][j];
      }
      rank++;
    }
    return rank;
  }

  /* ============================== 比特流 ============================== */

  const CODE = { R: '00', P: '01', S: '11' };

  function buildBits(history) {
    const out = [];
    for (const r of history) {
      const c = CODE[r.human];
      if (!c) continue;
      out.push(c.charCodeAt(0) - 48, c.charCodeAt(1) - 48);
    }
    return out;
  }

  /* ============================== 15 项检验 ============================== */

  /** 1. 频率检验（Monobit） */
  function tFrequency(b) {
    const n = b.length;
    let s = 0;
    for (const x of b) s += x ? 1 : -1;
    const sobs = Math.abs(s) / Math.sqrt(n);
    let ones = 0;
    for (const x of b) ones += x;
    return { stat: sobs, p: erfc(sobs / Math.SQRT2), detail: `1 的比例 ${((ones / n) * 100).toFixed(2)}%` };
  }

  /** 2. 块内频率检验（块长按样本量降档，样本足够时回到 NIST 的 128） */
  function tBlockFrequency(b) {
    const n = b.length;
    const M = pickTier(TIERS.block.list, n, TIERS.block.need);
    const N = Math.floor(n / M);
    if (N < 4) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ ${M * 4} 比特）` };
    let chi = 0;
    for (let i = 0; i < N; i++) {
      let ones = 0;
      for (let j = 0; j < M; j++) ones += b[i * M + j];
      chi += (ones / M - 0.5) ** 2;
    }
    chi *= 4 * M;
    return {
      stat: chi,
      p: igamc(N / 2, chi / 2),
      detail: `${N} 块 × ${M} 比特${M < 128 ? '（块长已按样本量降档）' : ''}`,
      small: M < 128,
    };
  }

  /** 3. 游程检验（Runs） */
  function tRuns(b) {
    const n = b.length;
    let ones = 0;
    for (const x of b) ones += x;
    const pi = ones / n;
    if (Math.abs(pi - 0.5) >= 2 / Math.sqrt(n)) {
      return { stat: NaN, p: 0, detail: '单比特比例失衡（|π−0.5| ≥ 2/√n），游程检验不适用' };
    }
    let v = 1;
    for (let i = 1; i < n; i++) if (b[i] !== b[i - 1]) v++;
    const num = Math.abs(v - 2 * n * pi * (1 - pi));
    const den = 2 * Math.sqrt(2 * n) * pi * (1 - pi);
    return { stat: num / den, p: erfc(num / den), detail: `游程数 ${v}` };
  }

  /** 4. 块内最长 1 游程检验 */
  const LONGEST_TABLES = {
    8: { M: 8, K: 3, base: 1, pi: [0.2148, 0.3672, 0.2305, 0.1875] },
    128: { M: 128, K: 5, base: 4, pi: [0.1174, 0.2430, 0.2493, 0.1752, 0.1027, 0.1124] },
    10000: { M: 10000, K: 6, base: 10, pi: [0.0882, 0.2092, 0.2483, 0.1933, 0.1208, 0.0675, 0.0727] },
  };

  function tLongestRun(b, cfg) {
    const { M, K, base, pi } = cfg;
    const n = b.length;
    const N = Math.floor(n / M);
    if (N < 4) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ ${M * 4} 比特）` };
    const v = new Array(pi.length).fill(0);
    for (let i = 0; i < N; i++) {
      let cur = 0;
      let max = 0;
      for (let j = 0; j < M; j++) {
        if (b[i * M + j]) { cur++; if (cur > max) max = cur; } else cur = 0;
      }
      // NIST 分类：≤ base → 第 0 档，base+1 … base+K-1 → 中间档，≥ base+K → 末档
      const idx = Math.min(pi.length - 1, Math.max(0, max - base));
      v[idx]++;
    }
    let chi = 0;
    for (let i = 0; i < pi.length; i++) chi += ((v[i] - N * pi[i]) ** 2) / (N * pi[i]);
    return { stat: chi, p: igamc(K / 2, chi / 2), detail: `${N} 块 × ${M} 比特` };
  }

  /** 5. 二元矩阵秩检验（极大样本走 NIST 原版 32×32；小样本降阶 + 满秩率二项检验） */
  function tRank(b) {
    const n = b.length;

    // NIST 原版：32×32 矩阵，满秩 / 差一 / 其余 三分类卡方
    if (n >= 38912) {
      const M = 32;
      const per = M * M;
      const N = Math.floor(n / per);
      let f = 0;
      let f1 = 0;
      let f2 = 0;
      for (let k = 0; k < N; k++) {
        const rows = [];
        for (let i = 0; i < M; i++) rows.push(b.slice(k * per + i * M, k * per + i * M + M));
        const r = gf2Rank(rows, M, M);
        if (r === M) f++;
        else if (r === M - 1) f1++;
        else f2++;
      }
      const e1 = N * 0.2888;
      const e2 = N * 0.5776;
      const e3 = N * 0.1336;
      const chi = (f - e1) ** 2 / e1 + (f1 - e2) ** 2 / e2 + (f2 - e3) ** 2 / e3;
      return { stat: chi, p: igamc(2, chi / 2), detail: `NIST 原版：${N} 个 32×32 矩阵` };
    }

    const m = pickTier(TIERS.rank.list, n, TIERS.rank.need);
    const per = m * m;
    const N = Math.floor(n / per);
    if (N < 2) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ ${per * 2} 比特）` };
    let full = 0;
    for (let k = 0; k < N; k++) {
      const rows = [];
      for (let i = 0; i < m; i++) rows.push(b.slice(k * per + i * m, k * per + i * m + m));
      if (gf2Rank(rows, m, m) === m) full++;
    }
    // 随机 GF(2) 矩阵满秩概率 = Π(1 − 2^(i−m))
    let pFull = 1;
    for (let i = 0; i < m; i++) pFull *= 1 - Math.pow(2, i - m);
    const z = (full - N * pFull) / Math.sqrt(Math.max(1e-9, N * pFull * (1 - pFull)));
    return {
      stat: Math.abs(z),
      p: erfc(Math.abs(z) / Math.SQRT2),
      detail: `小样本版：${N} 个 ${m}×${m} 矩阵，满秩 ${full}（期望 ${(N * pFull).toFixed(1)}）`,
      small: true,
    };
  }

  /** 6. 离散傅里叶变换（谱）检验 */
  function tDFT(b) {
    const n = b.length;
    const x = b.map((v) => (v ? 1 : -1));
    const mag = dftMag(x);
    const T = Math.sqrt(Math.log(1 / 0.05) * n);
    let n1 = 0;
    for (const m of mag) if (m < T) n1++;
    const n0 = 0.95 * (n / 2);
    const d = (n1 - n0) / Math.sqrt((n * 0.95 * 0.05) / 4);
    return { stat: Math.abs(d), p: erfc(Math.abs(d) / Math.SQRT2), detail: `阈值 ${T.toFixed(2)}，低于阈值的谱峰 ${n1}/${mag.length}` };
  }

  /** 模板出现次数的正态近似检验（非重叠 / 重叠共用） */
  function templateCheck(b, tpl, overlapping) {
    const n = b.length;
    const m = tpl.length;
    let obs = 0;
    for (let j = 0; j + m <= n; ) {
      let hit = true;
      for (let k = 0; k < m; k++) if (b[j + k] !== tpl[k]) { hit = false; break; }
      if (hit) { obs++; j += overlapping ? 1 : m; } else j++;
    }
    const mu = (n - m + 1) / Math.pow(2, m);
    const va = n * (1 / Math.pow(2, m) - (2 * m - 1) / Math.pow(2, 2 * m));
    const z = Math.abs(obs - mu) / Math.sqrt(Math.max(va, 1e-9));
    return { obs, mu, z };
  }

  /* 模板由 makeTemplates + TIERS.template 动态生成 */

  /** 7. 非重叠模板匹配（小样本版：整串统计 2 / 3 / 4 比特模板） */
  function tNonOverlapping(b) {
    const n = b.length;
    if (n < 24) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ 24 比特）` };
    const m = pickTier(TIERS.template.list, n, TIERS.template.need);
    const tpls = makeTemplates(m);
    let worst = 0;
    let minP = 1;
    for (const tpl of tpls) {
      const r = templateCheck(b, tpl, false);
      const p = erfc(r.z / Math.SQRT2);
      if (r.z > worst) worst = r.z;
      if (p < minP) minP = p;
    }
    return {
      stat: worst,
      p: minP,
      detail: `整串统计：4 个 ${m} 比特模板取最差（出现次数 vs 期望）`,
      small: true,
    };
  }

  /** 8. 重叠模板匹配（小样本版：整串统计 2 / 3 / 4 比特模板，重叠计数） */
  function tOverlapping(b) {
    const n = b.length;
    if (n < 24) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ 24 比特）` };
    const m = pickTier(TIERS.template.list, n, TIERS.template.need);
    const tpls = makeTemplates(m);
    let worst = 0;
    let minP = 1;
    for (const tpl of tpls) {
      const r = templateCheck(b, tpl, true);
      const p = erfc(r.z / Math.SQRT2);
      if (r.z > worst) worst = r.z;
      if (p < minP) minP = p;
    }
    return {
      stat: worst,
      p: minP,
      detail: `整串统计：4 个 ${m} 比特模板重叠计数，取最差`,
      small: true,
    };
  }

  /** 9. 通用统计检验（L 按样本量降档，样本充足时回到 NIST 的 L = 6） */
  function tUniversal(b) {
    const n = b.length;
    const L = pickTier(TIERS.universal.list, n, TIERS.universal.need);
    const Q = Math.min(10 * Math.pow(2, L), Math.max(4, Math.floor(n / L / 3)));
    const K = Math.floor(n / L) - Q;
    if (K < 4) {
      return { stat: NaN, p: NaN, detail: `样本不足（L = ${L} 时需要 ≥ ${(Q + 4) * L} 比特）` };
    }
    const fnOf = (bits) => {
      const table = new Int32Array(Math.pow(2, L));
      for (let i = 0; i < Q; i++) {
        let v = 0;
        for (let j = 0; j < L; j++) v = (v << 1) | bits[i * L + j];
        table[v] = i + 1;
      }
      let sum = 0;
      for (let i = Q; i < Q + K; i++) {
        let v = 0;
        for (let j = 0; j < L; j++) v = (v << 1) | bits[i * L + j];
        sum += Math.log2(i + 1 - table[v]);
        table[v] = i + 1;
      }
      return sum / K;
    };

    const fn = fnOf(b);
    // 蒙特卡洛标定：用相同 (L, Q, K) 的真随机序列估期望与标准差（固定种子，结果可复现）
    const R = 400;
    const rnd = mulberry32((0x9e3779b9 ^ (L * 7919 + Q * 31 + K * 7)) >>> 0);
    let m1 = 0;
    let m2 = 0;
    const len = (Q + K) * L;
    for (let r = 0; r < R; r++) {
      const v = fnOf(randBits(len, rnd));
      m1 += v;
      m2 += v * v;
    }
    const mean = m1 / R;
    const sd = Math.sqrt(Math.max(1e-9, m2 / R - mean * mean));
    const stat = Math.abs(fn - mean) / sd;
    return {
      stat,
      p: erfc(stat / Math.SQRT2),
      detail: `L = ${L}，Q = ${Q}，K = ${K}；fn = ${fn.toFixed(4)}，蒙特卡洛基准 ${mean.toFixed(4)}${L < 6 ? '（L 已按样本量降档）' : ''}`,
      small: L < 6,
    };
  }

  /** 10. 线性复杂度检验（块长按样本量降档，样本充足时回到 NIST 的 500 / 1000 / 5000） */
  function tLinearComplexity(b) {
    const n = b.length;
    const M = pickTier(TIERS.lc.list, n, TIERS.lc.need);
    const N = Math.floor(n / M);
    if (N < 2) return { stat: NaN, p: NaN, detail: `样本不足（需要 ≥ ${M * 2} 比特）` };
    let sum = 0;
    for (let i = 0; i < N; i++) sum += berlekampMassey(b.slice(i * M, (i + 1) * M));
    const meanLc = sum / N;
    const mu = M / 2 + (9 + Math.pow(-1, M + 1)) / 36 - (M / 3 + 2 / 9) / Math.pow(2, M);
    const sigma = Math.sqrt(86 / 81);
    const stat = Math.abs(meanLc - mu) / (sigma / Math.sqrt(N));
    return {
      stat,
      p: erfc(stat / Math.SQRT2),
      detail: `${N} 块 × ${M} 比特，平均复杂度 ${meanLc.toFixed(1)}（期望 ${mu.toFixed(1)}）${M < 500 ? '（块长已按样本量降档）' : ''}`,
      small: M < 500,
    };
  }

  /** Berlekamp-Massey：求比特序列的线性复杂度 */
  function berlekampMassey(seq) {
    const n = seq.length;
    const c = new Uint8Array(n);
    const b = new Uint8Array(n);
    c[0] = 1;
    b[0] = 1;
    let l = 0;
    let m = -1;
    for (let i = 0; i < n; i++) {
      let d = seq[i];
      for (let j = 1; j <= l; j++) d ^= c[j] & seq[i - j];
      if (d === 1) {
        const t = c.slice();
        const shift = i - m;
        for (let j = 0; j + shift < n; j++) c[j + shift] ^= b[j];
        if (l <= i / 2) {
          l = i + 1 - l;
          m = i;
          for (let j = 0; j < n; j++) b[j] = t[j];
        }
      }
    }
    return l;
  }

  /** 11. 序列检验（阶数按样本量自适应，上限 4） */
  function tSerial(b) {
    const n = b.length;
    const m = Math.max(2, Math.min(4, Math.floor(Math.log2(n)) - 3));
    const psi2 = (mm) => {
      if (mm <= 0) {
        let ones = 0;
        for (const x of b) ones += x;
        return (ones * ones + (n - ones) * (n - ones)) / n - n;
      }
      const size = Math.pow(2, mm);
      const counts = new Float64Array(size);
      for (let i = 0; i < n; i++) {
        let key = 0;
        for (let j = 0; j < mm; j++) key = (key << 1) | b[(i + j) % n];
        counts[key]++;
      }
      let s = 0;
      for (const c of counts) s += c * c;
      return (size / n) * s - n;
    };
    const p2 = psi2(m);
    const p1 = psi2(m - 1);
    const p0 = psi2(m - 2);
    const d2 = p2 - 2 * p1 + p0;
    const d1 = p2 - p1;
    return { stat: d2, p: igamc(Math.pow(2, m - 2), d2 / 2), detail: `m = ${m}，∇ψ² = ${d1.toFixed(3)}` };
  }

  /** 12. 近似熵检验（阶数按样本量自适应，上限 4） */
  function tApEn(b) {
    const n = b.length;
    const m = Math.max(2, Math.min(4, Math.floor(Math.log2(n)) - 3));
    const phi = (mm) => {
      const size = Math.pow(2, mm);
      const counts = new Float64Array(size);
      for (let i = 0; i < n; i++) {
        let key = 0;
        for (let j = 0; j < mm; j++) key = (key << 1) | b[(i + j) % n];
        counts[key]++;
      }
      let s = 0;
      for (const c of counts) {
        if (c > 0) { const p = c / n; s += p * Math.log(p); }
      }
      return s;
    };
    const apen = phi(m) - phi(m + 1);
    const chi = 2 * n * (Math.log(2) - apen);
    return { stat: chi, p: igamc(Math.pow(2, m - 1), chi / 2), detail: `m = ${m}，ApEn = ${apen.toFixed(4)}` };
  }

  /** 13. 累积和检验（Cusum） */
  function tCusum(b, forward) {
    const n = b.length;
    const seq = forward ? b : b.slice().reverse();
    let s = 0;
    let maxz = 0;
    for (const v of seq) {
      s += v ? 1 : -1;
      if (Math.abs(s) > maxz) maxz = Math.abs(s);
    }
    if (maxz === 0) return { stat: 0, p: 1, detail: '未出现偏离' };
    const sqrtN = Math.sqrt(n);
    let sum1 = 0;
    for (let k = Math.floor((-n / maxz + 1) / 4); k <= Math.floor((n / maxz - 1) / 4); k++) {
      sum1 += normCdf(((4 * k + 1) * maxz) / sqrtN) - normCdf(((4 * k - 1) * maxz) / sqrtN);
    }
    let sum2 = 0;
    for (let k = Math.floor((-n / maxz - 3) / 4); k <= Math.floor((n / maxz - 1) / 4); k++) {
      sum2 += normCdf(((4 * k + 3) * maxz) / sqrtN) - normCdf(((4 * k + 1) * maxz) / sqrtN);
    }
    const p = Math.max(0, Math.min(1, 1 - sum1 + sum2));
    return { stat: maxz, p, detail: `最大偏离 ${maxz}（${forward ? '正向' : '反向'}）` };
  }

  /** 累积和与分段：优先用 NIST 的「回到 0 循环」，样本不足时改用固定窗口 */
  function excursions(b) {
    const n = b.length;
    const S = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) S[i + 1] = S[i] + (b[i] ? 1 : -1);
    const cyc = [];
    let prev = 0;
    for (let i = 1; i <= n; i++) {
      if (S[i] === 0) { cyc.push([prev + 1, i + 1]); prev = i; }
    }
    if (cyc.length >= 500) return { S, cycles: cyc, mode: 'cycle' };
    const W = Math.max(8, Math.floor(n / 8));
    const segs = [];
    for (let a = 0; a + W <= n; a += W) segs.push([a + 1, a + W + 1]);
    return { S, cycles: segs, mode: 'window' };
  }

  /** 14. 随机游走检验（分周期与 NIST 一致；样本不足时按固定窗口分段） */
  function tExcursions(b) {
    const { S, cycles, mode } = excursions(b);
    const J = cycles.length;
    if (J < 3) return { stat: NaN, p: NaN, detail: `循环数 J = ${J}，太少（需要 ≥ 3）` };
    const STATES = [1, 2, 3, 4, -1, -2, -3, -4];
    const P0 = { 1: 0.5, 2: 0.75, 3: 0.8333, 4: 0.875 };
    let worstZ = 0;
    let minP = 1;
    for (const x of STATES) {
      let hit = 0;
      for (const [a, z] of cycles) {
        for (let i = a; i < z; i++) if (S[i] === x) { hit++; break; }
      }
      const p1 = 1 - P0[Math.abs(x)];
      const z = (hit - J * p1) / Math.sqrt(J * p1 * (1 - p1));
      if (Math.abs(z) > worstZ) worstZ = Math.abs(z);
      const p = erfc(Math.abs(z) / Math.SQRT2);
      if (p < minP) minP = p;
    }
    return {
      stat: worstZ,
      p: minP,
      detail: `${mode === 'cycle' ? 'NIST 循环' : '固定窗口'} J = ${J}，看「每段是否访问过状态 x」的比例`,
      small: mode !== 'cycle',
    };
  }

  /** 15. 随机游走变体检验（分周期与 NIST 一致；样本不足时按固定窗口分段） */
  function tExcursionsVariant(b) {
    const { S, cycles, mode } = excursions(b);
    const J = cycles.length;
    if (J < 3) return { stat: NaN, p: NaN, detail: `循环数 J = ${J}，太少（需要 ≥ 3）` };
    const STATES = [1, 2, 3, 4, 5, 6, 7, 8, 9, -1, -2, -3, -4, -5, -6, -7, -8, -9];
    let minP = 1;
    let minZ = 0;
    for (const x of STATES) {
      let xi = 0;
      for (const [a, z] of cycles) for (let i = a; i < z; i++) if (S[i] === x) xi++;
      const z = Math.abs(xi - J) / Math.sqrt(2 * J * (4 * Math.abs(x) - 2));
      const p = erfc(z / Math.SQRT2);
      if (p < minP) { minP = p; minZ = z; }
    }
    return {
      stat: minZ,
      p: minP,
      detail: `${mode === 'cycle' ? 'NIST 循环' : '固定窗口'} J = ${J}，取 18 个状态中最小的 p 值`,
      small: mode !== 'cycle',
    };
  }

  /* ============================== 执行入口 ============================== */

  /** 跑完 15 项（累积和拆为正向/反向共 16 行），返回原始统计量与 NIST 解析 p 值 */
  function rawStats(bits) {
    const n = bits.length;
    const list = [];

    const add = (name, en, r) => {
      const ok = Number.isFinite(r.p);
      list.push({
        name,
        en,
        stat: r.stat,
        p: r.p,
        detail: r.detail || '',
        small: !!r.small,
        ok,
        pass: ok && r.p >= 0.01,
        edge: ok && r.p >= 0.01 && r.p < 0.05,
      });
    };

    add('频率检验', 'Frequency (Monobit)', tFrequency(bits));
    add('块内频率检验', 'Frequency Test within a Block', tBlockFrequency(bits));
    add('游程检验', 'Runs', tRuns(bits));
    add('最长 1 游程', 'Longest Run of Ones', tLongestRun(bits, LONGEST_TABLES[pickTier(TIERS.longest.list, n, TIERS.longest.need)]));
    add('二元矩阵秩', 'Binary Matrix Rank', tRank(bits));
    add('离散傅里叶变换', 'Discrete Fourier Transform', tDFT(bits));
    add('非重叠模板匹配', 'Non-overlapping Template Matching', tNonOverlapping(bits));
    add('重叠模板匹配', 'Overlapping Template Matching', tOverlapping(bits));
    add('通用统计检验', "Maurer's Universal Statistical", tUniversal(bits));
    add('线性复杂度', 'Linear Complexity', tLinearComplexity(bits));
    add('序列检验', 'Serial', tSerial(bits));
    add('近似熵检验', 'Approximate Entropy', tApEn(bits));
    add('累积和检验（正向）', 'Cumulative Sums (Forward)', tCusum(bits, true));
    add('累积和检验（反向）', 'Cumulative Sums (Reverse)', tCusum(bits, false));
    add('随机游走检验', 'Random Excursions', tExcursions(bits));
    add('随机游走变体检验', 'Random Excursions Variant', tExcursionsVariant(bits));

    return list;
  }

  /** 经验双边 p 值（以零分布中位数为中心） */
  function empiricalP(stat, arr) {
    if (!Number.isFinite(stat) || !arr.length) return NaN;
    const sorted = arr.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const d = Math.abs(stat - med);
    let cnt = 0;
    for (const v of sorted) if (Math.abs(v - med) >= d - 1e-12) cnt++;
    return Math.min(1, Math.max(1 / (sorted.length + 1), cnt / (sorted.length + 1)));
  }

  /**
   * 跑完整套件。
   * resample（可选）返回一段「同样编码、同样长度」的真随机比特流，用于**零分布标定**：
   * 用 200 条模拟序列的统计量经验分布重算 p 值，自动抵消「2 比特编码受限」与样本量带来的偏差，
   * 也让「取多个模板中最差」这类多重比较自动得到校正。
   */
  function run(bits, resample) {
    const rows = rawStats(bits);
    if (typeof resample !== 'function') return rows;

    const R = 200;
    const nulls = rows.map(() => []);
    for (let r = 0; r < R; r++) {
      const sim = rawStats(resample());
      for (let i = 0; i < rows.length; i++) {
        if (Number.isFinite(sim[i].stat)) nulls[i].push(sim[i].stat);
      }
    }
    for (let i = 0; i < rows.length; i++) {
      if (!Number.isFinite(rows[i].stat) || nulls[i].length < 40) continue;
      rows[i].nistP = rows[i].p;
      rows[i].p = empiricalP(rows[i].stat, nulls[i]);
      rows[i].calib = true;
      rows[i].pass = rows[i].p >= 0.01;
      rows[i].edge = rows[i].p >= 0.01 && rows[i].p < 0.05;
    }
    return rows;
  }

  window.RPS_NIST = { buildBits, run, rawStats, CODE };
})();
