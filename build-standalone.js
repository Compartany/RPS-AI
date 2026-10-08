#!/usr/bin/env node
/**
 * 打包单文件：把 index.html 引用的样式表与脚本就地内联，产出 dist/RPS-AI.html。
 * 供「拷到手机、用浏览器直接打开 file://」使用（不需要服务器）。
 *
 * 用法：node build-standalone.js
 *
 * 原则：
 *   - 只读源文件，不改动任何现有文件；dist/ 是独立产物；
 *   - 内联顺序完全跟随 index.html（不硬编码文件名，避免漏掉或错位）；
 *   - 不做压缩，产物保持可读；
 *   - 内联数量与源文件引用数不一致时直接报错退出，不产出半成品。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_NAME = 'RPS-AI.html';
const ENTRY = path.join(ROOT, 'index.html');

/** 匹配 <link rel="stylesheet" ...>（连同它独占的一行） */
const RE_LINK = /[ \t]*<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>[ \t]*\n?/gi;
/** 匹配成对的 <script src="..."></script>（连同它独占的一行） */
const RE_SCRIPT = /[ \t]*<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>[ \t]*\n?/gi;

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/** 读取相对路径的文本文件；顺便把 CRLF 归一成 LF（最后按源 index.html 的风格统一还原） */
function readRel(rel) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    die('读不到 index.html 引用的文件：' + rel + '（' + e.message + '）');
  }
  return text.replace(/\r\n/g, '\n');
}

/** 防御性转义：避免内联内容提前闭合所在的 <style>（本项目源码里并不存在该序列） */
function escapeStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style');
}
/** 防御性转义：避免内联内容提前闭合所在的 <script> */
function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

/** 只允许相对路径：绝对 URL / 协议相对 URL 内联不了 */
function assertLocal(rel, kind) {
  if (isExternal(rel)) {
    die('index.html 里的' + kind + '不是相对路径，无法内联：' + rel);
  }
}

/** 绝对 URL / 协议相对 URL（如 CDN 字体），这类外链不内联、原样留在产物里 */
function isExternal(rel) {
  return /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//');
}

function main() {
  if (!fs.existsSync(ENTRY)) die('找不到 index.html（构建脚本须放在项目根目录）。');

  const rawHtml = fs.readFileSync(ENTRY, 'utf8');
  const EOL = rawHtml.includes('\r\n') ? '\r\n' : '\n';
  let html = rawHtml.replace(/\r\n/g, '\n');

  // ---- 1. 先数清楚源文件引用了几个 ----
  const localLinks = (html.match(RE_LINK) || []).filter((tag) => {
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    return m && !isExternal(m[1]);
  });
  const wantStyles = localLinks.length;
  const wantScripts = (html.match(RE_SCRIPT) || []).length;
  if (!wantStyles) die('index.html 里没找到 <link rel="stylesheet">，构建脚本已与源文件脱节。');
  if (!wantScripts) die('index.html 里没找到带 src 的 <script>，构建脚本已与源文件脱节。');

  const styles = [];
  const scripts = [];

  // ---- 2. 就地内联样式表（CDN 等绝对 URL 原样留着） ----
  html = html.replace(RE_LINK, (tag) => {
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!m) die('有个 <link rel="stylesheet"> 没有 href：' + tag.trim());
    if (isExternal(m[1])) return tag;
    styles.push(m[1]);
    // <style> 元素内的 @charset 按规范无效，剥掉（编码已由 HTML 的 <meta charset> 声明）
    const css = readRel(m[1]).replace(/^\s*@charset\s+["'][^"']*["']\s*;\n?/i, '');
    return '<style>\n' + escapeStyle(css) + '\n</style>\n';
  });

  // ---- 3. 就地内联脚本（按 index.html 中出现的先后顺序） ----
  html = html.replace(RE_SCRIPT, (tag, src) => {
    if (/\btype\s*=\s*["']module["']/i.test(tag)) {
      die('发现 type="module" 的脚本，无法内联（本项目约定使用经典脚本）：' + src);
    }
    assertLocal(src, '脚本');
    scripts.push(src);
    return '<script>\n' + escapeScript(readRel(src)) + '\n</script>\n';
  });

  // ---- 4. 校验：数量对得上、且产物里不再有本地外链 ----
  if (styles.length !== wantStyles) die('样式表内联数量不符：源 ' + wantStyles + ' 个，实际内联 ' + styles.length + ' 个。');
  if (scripts.length !== wantScripts) die('脚本内联数量不符：源 ' + wantScripts + ' 个，实际内联 ' + scripts.length + ' 个。');
  if (html.split('<style>').length - 1 !== styles.length) die('产物里 <style> 数量与内联样式表数量不符。');
  if (/<script\b[^>]*\bsrc=/i.test(html)) die('产物里仍残留外链脚本。');

  // ---- 5. 写盘（行尾还原成源 index.html 的风格） ----
  const out = EOL === '\r\n' ? html.replace(/\n/g, '\r\n') : html;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, OUT_NAME);
  fs.writeFileSync(outPath, out, 'utf8');

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('✓ 已内联样式表 ' + styles.length + ' 个、脚本 ' + scripts.length + ' 个');
  console.log('  样式：' + styles.join('、'));
  console.log('  脚本：' + scripts.join(' → '));
  console.log('✓ 产物：' + path.relative(ROOT, outPath) + '（' + kb(Buffer.byteLength(out, 'utf8')) +
    '；源 index.html + 资源合计 ' + kb(Buffer.byteLength(rawHtml, 'utf8') + styles.concat(scripts)
      .reduce((sum, rel) => sum + Buffer.byteLength(readRel(rel), 'utf8'), 0)) + '）');
  console.log('  说明：该文件供手机拷贝后用浏览器直接打开；电脑上仍可直接打开 index.html。');
}

main();
