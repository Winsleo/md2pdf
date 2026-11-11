#!/usr/bin/env node
/**
 * md2pdf — Markdown(+LaTeX 公式, 图片) → PDF
 * 流程：markdown-it 解析 → KaTeX 渲染公式 → 图片/字体内嵌为自包含 HTML
 *       → puppeteer-core 驱动系统 Chrome 打印 PDF（带页码、可选页眉）
 * 用法见 README.md，或运行 `node md2pdf.js --help`。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const PKG = require('./package.json');
const DEPS = ['markdown-it', 'katex', 'markdown-it-texmath', 'puppeteer-core'];
const USAGE = `用法：
  node md2pdf.js <input.md> [选项]

选项：
  -o, --output <file.pdf>   输出文件（默认：与输入同名、同目录的 .pdf）
      --paper <A4|A3|A5|B5|Letter|Legal|Tabloid>   纸张（默认 A4）
      --margin <毫米>        页边距，单个数字或 "上下,左右"（默认 "18,16"）
      --font-size <pt>       正文字号，5–30（默认 10.5）
      --font <字体名>        正文字体，放在字体栈最前面（例如 "Noto Sans CJK SC"）
      --css <file.css>       追加自定义 CSS（可覆盖默认样式）
      --title <文字>         PDF 标题（默认取第一个 # 标题）
      --no-h1-break          一级标题前不强制换页（默认每个 # 前换页）
      --no-page-numbers      不要页码（默认在页脚居中显示 "当前页 / 总页数"）
      --header <文字>        每页页眉文字（默认无）
      --no-html              不解析 Markdown 里的原始 HTML（转换来路不明的文档时更安全）
      --keep-html            保留中间生成的 .html（与输出同名）
      --chrome <path>        指定 Chrome/Chromium 可执行文件
      --check                检查环境（Node、依赖、Chrome、中文字体）后退出
  -v, --version              显示版本
  -h, --help                 显示本帮助

环境变量：
  CHROME_PATH         可代替 --chrome
  MD2PDF_NO_SANDBOX=1 以 --no-sandbox 启动 Chrome（Linux root 容器里通常需要）`;

/** 统一的失败出口：抛错交给 main().catch 处理，保证各层 finally 能执行。 */
function fail(msg) {
  const e = new Error(msg);
  e.friendly = true; // 只打印 message，不打印 stack
  throw e;
}

// ───────────────────────────── 参数 ─────────────────────────────

function parseArgs(argv) {
  const o = { margin: '18,16', paper: 'A4', fontSize: '10.5', h1Break: true, pageNumbers: true };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline; // 支持 --paper=A4 形式
    if (flag.startsWith('--')) {
      const eq = flag.indexOf('=');
      if (eq > 2) { inline = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    }
    if (flag === '--') { positionals.push(...argv.slice(i + 1)); break; }

    const take = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) fail(`选项 ${flag} 缺少参数`);
      return argv[++i];
    };

    switch (flag) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--check': o.check = true; break;
      case '--no-h1-break': o.h1Break = false; break;
      case '--no-page-numbers': o.pageNumbers = false; break;
      case '--no-html': o.html = false; break;
      case '--keep-html': o.keepHtml = true; break;
      case '-o': case '--output': o.output = take(); break;
      case '--paper': o.paper = take(); break;
      case '--margin': o.margin = take(); break;
      case '--font-size': o.fontSize = take(); break;
      case '--font': o.font = take(); break;
      case '--css': o.css = take(); break;
      case '--title': o.title = take(); break;
      case '--chrome': o.chrome = take(); break;
      case '--header': o.header = take(); break;
      default:
        if (flag.startsWith('-') && flag !== '-') fail(`未知选项：${flag}\n\n${USAGE}`);
        positionals.push(flag);
    }
  }

  if (positionals.length > 1) fail(`只能指定一个输入文件（多余：${positionals.slice(1).join(', ')}）`);
  if (positionals.length === 1) o.input = positionals[0];
  return o;
}

const PAPER_ALIASES = {
  a3: 'A3', a4: 'A4', a5: 'A5', a6: 'A6',
  b4: 'B4', b5: 'B5', letter: 'Letter', legal: 'Legal', tabloid: 'Tabloid',
};

function normalizePaper(v) {
  const paper = PAPER_ALIASES[String(v).trim().toLowerCase()];
  if (!paper) fail(`不支持的纸张：${v}（可选：A3 A4 A5 A6 B4 B5 Letter Legal Tabloid）`);
  return paper;
}

/** "18" → {v:18,h:18}；"18,16" → {v:18,h:16}。单位毫米，不接受负数/非数字。 */
function parseMargin(v) {
  const parts = String(v).split(',').map(s => s.trim());
  if (parts.length > 2) fail(`页边距格式不对：${v}（应为 "18" 或 "18,16"）`);
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) fail(`页边距格式不对：${v}（应为非负数字，单位毫米）`);
    if (Number(p) > 100) fail(`页边距过大：${v}（单边不超过 100 毫米）`);
  }
  const v1 = Number(parts[0]);
  return { v: v1, h: parts[1] === undefined ? v1 : Number(parts[1]) };
}

function parseFontSize(v) {
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 5 || n > 30) fail(`字号不合法：${v}（应为 5–30 之间的数字，单位 pt）`);
  return n;
}

/** 去掉会破坏 CSS 字符串的引号/反斜杠。 */
function sanitizeFontName(v) {
  return String(v).replace(/["'\\]/g, '').trim();
}

// ───────────────────────────── 环境 ─────────────────────────────

function findChrome(explicit) {
  const wanted = explicit || process.env.CHROME_PATH;
  if (wanted) {
    // 明确指定了就只认它，不要悄悄换成别的浏览器
    if (path.isAbsolute(wanted)) return fs.existsSync(wanted) ? wanted : null;
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [wanted], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
  }
  const cands = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of cands) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

function haveCjkFont() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true; // 系统自带中文字体
  const r = spawnSync('fc-list', [':lang=zh'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function checkEnv(o) {
  let ok = true;
  const line = (good, msg) => { console.log((good ? '[ OK ] ' : '[FAIL] ') + msg); if (!good) ok = false; };
  line(parseInt(process.versions.node, 10) >= 18, `Node ${process.versions.node}（需要 ≥ 18）`);
  for (const m of DEPS) {
    try { line(true, `依赖 ${m} ${require(m + '/package.json').version}`); }
    catch { line(false, `缺少依赖 ${m}：请在仓库目录运行 npm install`); }
  }
  try { require.resolve('katex/dist/katex.min.css'); line(true, 'KaTeX 样式与字体文件'); }
  catch { line(false, '找不到 katex/dist/katex.min.css：依赖可能不完整，请重新 npm install'); }
  const chrome = findChrome(o.chrome);
  if (chrome) {
    const v = spawnSync(chrome, ['--version'], { encoding: 'utf8' });
    line(true, `Chrome：${chrome}（${(v.stdout || '').trim()}）`);
  } else line(false, '找不到 Chrome/Chromium：请安装，或用 --chrome / CHROME_PATH 指定');
  line(haveCjkFont(), '中文字体（Linux 上可装：sudo apt install fonts-noto-cjk）');
  process.exitCode = ok ? 0 : 1;
}

// ───────────────────────────── 图片内嵌 ─────────────────────────────

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
};

/** 扩展名缺失或不可信时按文件头判断类型。 */
function sniffMime(buf) {
  const at = (from, to) => buf.slice(from, to).toString('latin1');
  if (buf.length >= 8 && buf[0] === 0x89 && at(1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (at(0, 6) === 'GIF87a' || at(0, 6) === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && at(0, 2) === 'BM') return 'image/bmp';
  if (buf.length >= 12 && at(4, 8) === 'ftyp' && (at(8, 12) === 'avif' || at(8, 12) === 'avis')) return 'image/avif';
  const head = buf.slice(0, 4096).toString('utf8');
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** decodeURIComponent 遇到孤立的 % 会抛错，这里退化为原字符串。 */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * 把 <img src="本地路径"> 换成 base64 data URI。
 * - 支持双引号和单引号属性
 * - 跳过 data:/http(s):/file:// 这类外部地址（交给 Chrome 自己加载）
 * - 同一文件只编码一次
 * - 找不到或不认识的格式收集进 missing，由调用方警告
 */
function inlineImages(html, baseDir) {
  const missing = [];
  const cache = new Map();
  const out = html.replace(/<img\b([^>]*?)\bsrc=(["'])(.*?)\2/gi, (m, pre, quote, rawSrc) => {
    const src = rawSrc.trim();
    if (/^(data:|https?:|file:|\/\/)/i.test(src)) return m;
    const clean = safeDecode(src.split(/[?#]/)[0]);
    const file = path.resolve(baseDir, clean);
    let uri = cache.get(file);
    if (!uri) {
      let buf;
      try { buf = fs.readFileSync(file); } catch { missing.push(src); return m; }
      const mime = MIME[path.extname(file).slice(1).toLowerCase()] || sniffMime(buf);
      if (!mime) { missing.push(src); return m; }
      uri = `data:${mime};base64,${buf.toString('base64')}`;
      cache.set(file, uri);
    }
    return `<img${pre}src="${uri}"`;
  });
  return { html: out, missing };
}

// ───────────────────────────── HTML / CSS ─────────────────────────────

let katexCssCache = null;

function katexCss() {
  if (katexCssCache) return katexCssCache;
  const dist = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8');
  // 只保留 woff2，其余格式去掉以减小体积；再把 woff2 内嵌为 data URI
  css = css.replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, '')
           .replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '');
  katexCssCache = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (m, f) => {
    const p = path.join(dist, 'fonts', f);
    return fs.existsSync(p) ? `url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')})` : m;
  });
  return katexCssCache;
}

function buildCss(o) {
  const margin = `${o.marginV}mm ${o.marginH}mm`;
  const fonts = [o.fontName && `"${o.fontName}"`, '"Noto Serif CJK SC"', '"Noto Sans CJK SC"', '"Source Han Serif SC"',
    '"Songti SC"', '"PingFang SC"', '"Microsoft YaHei"', '"WenQuanYi Micro Hei"', 'serif'].filter(Boolean).join(',');
  return `
@page{size:${o.paper};margin:${margin}}
body{font-family:${fonts};font-size:${o.fontSize}pt;line-height:1.65;color:#111}
h1{font-size:1.6em;border-bottom:2px solid #333;padding-bottom:4px;margin-top:26px;${o.h1Break ? 'page-break-before:always;break-before:page;' : ''}}
h1:first-of-type{page-break-before:avoid;break-before:avoid}
h2{font-size:1.28em;margin-top:18px} h3{font-size:1.1em;margin-top:14px}
h1,h2,h3{break-after:avoid;page-break-after:avoid} p,li{orphans:2;widows:2}
table{border-collapse:collapse;margin:8px auto;font-size:.9em;page-break-inside:avoid} th,td{border:1px solid #888;padding:3px 8px}
th{background:#eee} img{max-width:100%;display:block;margin:8px auto;page-break-inside:avoid}
pre{background:#f5f5f5;padding:8px 10px;white-space:pre-wrap;overflow-wrap:break-word;page-break-inside:avoid}
code{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:.86em;background:#f2f2f2;padding:0 2px}
pre code{background:none;padding:0}
hr{display:none} blockquote{border-left:3px solid #999;margin-left:0;padding-left:10px;color:#333}
.katex-display{margin:.7em 0;max-width:100%;overflow:visible} p{margin:.5em 0}`;
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 取第一个 # 标题，跳过代码块里的 # 注释。 */
function extractTitle(src, input) {
  let inFence = false;
  for (const line of String(src).split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return path.basename(input);
}

/** 页眉页脚模板（Puppeteer 要求内联样式；class=pageNumber/totalPages 会被自动替换为页码）。 */
function headerFooter(o) {
  const base = `font-size:9px;color:#555;font-family:'Noto Sans CJK SC','Noto Sans',sans-serif;width:100%;`;
  const header = o.header
    ? `<div style="${base}padding:0 ${o.marginH}mm;text-align:left">${escHtml(o.header)}</div>`
    : '<div></div>';
  const footer = o.pageNumbers
    ? `<div style="${base}text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
    : '<div></div>';
  return { header, footer, enabled: Boolean(o.header) || o.pageNumbers };
}

function render(o) {
  const MarkdownIt = require('markdown-it');
  const katex = require('katex');
  const md = new MarkdownIt({ html: o.html !== false });
  md.use(require('markdown-it-texmath'), {
    engine: katex, delimiters: 'dollars',
    katexOptions: { throwOnError: false, strict: 'ignore' },
  });
  const src = fs.readFileSync(o.input, 'utf8');
  const { html, missing } = inlineImages(md.render(src), path.dirname(path.resolve(o.input)));
  const mathErr = (html.match(/katex-error/g) || []).length;
  const title = escHtml(o.title || extractTitle(src, o.input));
  const extra = o.css ? fs.readFileSync(o.css, 'utf8') : '';
  const doc = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>${katexCss()}</style><style>${buildCss(o)}${extra}</style></head><body data-md2pdf="1">${html}</body></html>`;
  return { doc, missing, mathErr };
}

// ───────────────────────────── 打印 ─────────────────────────────

/** 这些错误通常意味着当前环境不允许 Chrome 起沙箱，值得关掉沙箱再试一次。 */
const SANDBOX_HINT = /sandbox|main frame too early|Failed to launch|Target closed|Session closed|crash/i;

async function printPdf(chrome, htmlPath, out, o) {
  const puppeteer = require('puppeteer-core');
  // 必须转成 file URL：路径里的空格、#、%、中文都要正确转义
  const url = pathToFileURL(htmlPath).href;
  const forced = process.env.MD2PDF_NO_SANDBOX === '1' ||
    (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0);
  // 默认保留 Chrome 沙箱（转换来路不明的文档时更安全），失败再降级
  const attempts = forced ? [true] : [false, true];

  let browser = null;
  let page = null;
  let lastErr = null;
  let usedNoSandbox = false;

  for (const noSandbox of attempts) {
    try {
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: noSandbox ? ['--disable-gpu', '--no-sandbox'] : ['--disable-gpu'],
      });
      page = await browser.newPage();
      page.setDefaultTimeout(120000);
      await page.goto(url, { waitUntil: 'load' });
      usedNoSandbox = noSandbox;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (browser) { await browser.close().catch(() => {}); browser = null; page = null; }
      // 与沙箱无关的错误（比如文件不存在）没必要再试一遍
      if (!SANDBOX_HINT.test(String(e && e.message))) break;
    }
  }

  if (!page) fail(`无法启动 Chrome 或打开页面：${String(lastErr && lastErr.message).split('\n')[0]}（可运行 --check 排查）`);
  if (usedNoSandbox && !forced) {
    console.warn('提示：当前环境不允许 Chrome 使用沙箱，已自动改用 --no-sandbox 启动（转换来路不明的文档时请留意）。');
  }

  try {
    const loaded = await page.evaluate(() => Boolean(document.querySelector('body[data-md2pdf]')));
    if (!loaded) fail(`页面加载失败（Chrome 可能显示的是错误页）：${url}`);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const hf = headerFooter(o);
    await page.pdf({
      path: out, preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: hf.enabled, headerTemplate: hf.header, footerTemplate: hf.footer,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

function defaultOutput(input) {
  const ext = path.extname(input);
  const stem = /^\.(md|markdown|mdown|mkd)$/i.test(ext) ? input.slice(0, -ext.length) : input;
  return stem + '.pdf';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  if (o.version) { console.log(PKG.version); return; }
  if (o.check) return checkEnv(o);
  if (!o.input) fail('请指定输入的 .md 文件\n\n' + USAGE);

  let stat;
  try { stat = fs.statSync(o.input); } catch { fail(`找不到输入文件：${o.input}`); }
  if (!stat.isFile()) fail(`输入不是文件：${o.input}`);

  try { for (const m of DEPS) require(m); }
  catch { fail('缺少依赖：请在仓库目录运行 npm install'); }
  const chrome = findChrome(o.chrome);
  if (!chrome) fail('找不到 Chrome/Chromium。请安装，或用 --chrome / CHROME_PATH 指定路径（可先运行 --check）');

  if (o.css) {
    let cssStat;
    try { cssStat = fs.statSync(o.css); } catch { fail(`找不到 CSS 文件：${o.css}`); }
    if (!cssStat.isFile()) fail(`--css 不是文件：${o.css}`);
  }

  // 参数校验放在真正干活之前，避免"静默用了错误的值"
  o.paper = normalizePaper(o.paper);
  const m = parseMargin(o.margin);
  o.marginV = m.v; o.marginH = m.h;
  o.fontSize = parseFontSize(o.fontSize);
  if (o.font) o.fontName = sanitizeFontName(o.font);

  const out = path.resolve(o.output || defaultOutput(o.input));
  if (out === path.resolve(o.input)) fail('输出文件不能与输入文件相同（会覆盖源文件）');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const { doc, missing, mathErr } = render(o);

  let tmpDir = null;
  let htmlPath;
  if (o.keepHtml) {
    htmlPath = out.replace(/\.pdf$/i, '') + '.html';
    if (path.resolve(htmlPath) === path.resolve(o.input)) fail('--keep-html 生成的 .html 会覆盖输入文件，请换一个 -o');
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-'));
    htmlPath = path.join(tmpDir, 'doc.html');
  }
  fs.writeFileSync(htmlPath, doc);

  try {
    await printPdf(chrome, htmlPath, out, o);
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(out)) fail('没有生成 PDF');

  const size = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`已生成：${out}（${size} KB）`);
  if (missing.length) console.warn(`警告：${missing.length} 张图片没找到或格式不支持：${[...new Set(missing)].join(', ')}`);
  if (mathErr) console.warn(`警告：有 ${mathErr} 处公式渲染失败（PDF 里会显示成红色源码）。请检查 LaTeX 语法`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('错误：' + (e && e.friendly ? e.message : (e && e.stack) || String(e)));
    process.exitCode = 1;
  });
} else {
  // 供 test/ 下的单元测试使用（require 时不会执行 main）
  module.exports = {
    parseArgs, parseMargin, parseFontSize, normalizePaper, sanitizeFontName,
    inlineImages, sniffMime, safeDecode, buildCss, headerFooter,
    extractTitle, defaultOutput, findChrome,
  };
}
