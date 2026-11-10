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

const DEPS = ['markdown-it', 'katex', 'markdown-it-texmath', 'puppeteer-core'];
const USAGE = `用法：
  node md2pdf.js <input.md> [选项]

选项：
  -o, --output <file.pdf>   输出文件（默认：与输入同名、同目录的 .pdf）
      --paper <A4|A3|Letter|Legal>   纸张（默认 A4）
      --margin <毫米>        页边距，单个数字或 "上下,左右"（默认 "18,16"）
      --font-size <pt>       正文字号（默认 10.5）
      --font <字体名>        正文字体，放在字体栈最前面（例如 "Noto Sans CJK SC"）
      --css <file.css>       追加自定义 CSS（可覆盖默认样式）
      --title <文字>         PDF 标题（默认取第一个 # 标题）
      --no-h1-break          一级标题前不强制换页（默认每个 # 前换页）
      --no-page-numbers      不要页码（默认在页脚居中显示 "当前页 / 总页数"）
      --header <文字>        每页页眉文字（默认无）
      --keep-html            保留中间生成的 .html（与输出同名）
      --chrome <path>        指定 Chrome/Chromium 可执行文件
      --check                检查环境（Node、依赖、Chrome、中文字体）后退出
  -h, --help                 显示本帮助

环境变量：CHROME_PATH 可代替 --chrome。`;

function parseArgs(argv) {
  const o = { margin: '18,16', paper: 'A4', fontSize: '10.5', h1Break: true, pageNumbers: true };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) fail(`选项 ${flag} 缺少参数`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--check': o.check = true; break;
      case '-o': case '--output': o.output = need(i++, a); break;
      case '--paper': o.paper = need(i++, a); break;
      case '--margin': o.margin = need(i++, a); break;
      case '--font-size': o.fontSize = need(i++, a); break;
      case '--font': o.font = need(i++, a); break;
      case '--css': o.css = need(i++, a); break;
      case '--title': o.title = need(i++, a); break;
      case '--chrome': o.chrome = need(i++, a); break;
      case '--no-h1-break': o.h1Break = false; break;
      case '--no-page-numbers': o.pageNumbers = false; break;
      case '--header': o.header = need(i++, a); break;
      case '--keep-html': o.keepHtml = true; break;
      default:
        if (a.startsWith('-')) fail(`未知选项：${a}\n\n${USAGE}`);
        if (o.input) fail(`只能指定一个输入文件（多余：${a}）`);
        o.input = a;
    }
  }
  return o;
}

function fail(msg) {
  console.error('错误：' + msg);
  process.exit(1);
}

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
  const chrome = findChrome(o.chrome);
  if (chrome) {
    const v = spawnSync(chrome, ['--version'], { encoding: 'utf8' });
    line(true, `Chrome：${chrome}（${(v.stdout || '').trim()}）`);
  } else line(false, '找不到 Chrome/Chromium：请安装，或用 --chrome / CHROME_PATH 指定');
  line(haveCjkFont(), '中文字体（Linux 上可装：sudo apt install fonts-noto-cjk）');
  process.exit(ok ? 0 : 1);
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp' };

function inlineImages(html, baseDir) {
  const missing = [];
  const out = html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"/g, (m, pre, src) => {
    if (/^(data:|https?:|file:)/i.test(src)) return m;
    const file = path.resolve(baseDir, decodeURIComponent(src));
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!fs.existsSync(file) || !MIME[ext]) { missing.push(src); return m; }
    return `<img${pre}src="data:${MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}"`;
  });
  return { html: out, missing };
}

function katexCss() {
  const dist = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8');
  // 只保留 woff2，其余格式去掉以减小体积；再把 woff2 内嵌为 data URI
  css = css.replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, '')
           .replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '');
  return css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (m, f) => {
    const p = path.join(dist, 'fonts', f);
    return fs.existsSync(p) ? `url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')})` : m;
  });
}

function buildCss(o) {
  const [mv, mh] = o.margin.split(',').map(s => s.trim());
  const margin = `${mv}mm ${mh === undefined ? mv : mh}mm`;
  const fonts = [o.font && `"${o.font}"`, '"Noto Serif CJK SC"', '"Noto Sans CJK SC"', '"Source Han Serif SC"',
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
pre{background:#f5f5f5;padding:8px 10px;overflow-x:auto;white-space:pre-wrap;page-break-inside:avoid}
code{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:.86em;background:#f2f2f2;padding:0 2px}
pre code{background:none;padding:0}
hr{display:none} blockquote{border-left:3px solid #999;margin-left:0;padding-left:10px;color:#333}
.katex-display{margin:.7em 0;overflow-x:auto;overflow-y:hidden} p{margin:.5em 0}`;
}

function render(o) {
  const MarkdownIt = require('markdown-it');
  const katex = require('katex');
  const md = new MarkdownIt({ html: true });
  md.use(require('markdown-it-texmath'), {
    engine: katex, delimiters: 'dollars',
    katexOptions: { throwOnError: false, strict: 'ignore' },
  });
  const src = fs.readFileSync(o.input, 'utf8');
  let body = md.render(src);
  const { html, missing } = inlineImages(body, path.dirname(path.resolve(o.input)));
  body = html;
  const mathErr = (body.match(/katex-error/g) || []).length;
  const title = o.title || (src.match(/^#\s+(.+)$/m) || [, path.basename(o.input)])[1].replace(/[<>&]/g, '');
  const extra = o.css ? fs.readFileSync(o.css, 'utf8') : '';
  const doc = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>${katexCss()}</style><style>${buildCss(o)}${extra}</style></head><body>${body}</body></html>`;
  return { doc, missing, mathErr };
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 页眉页脚模板（Puppeteer 要求内联样式；class=pageNumber/totalPages 会被自动替换为页码）。 */
function headerFooter(o) {
  const mh = (o.margin.split(',')[1] ?? o.margin.split(',')[0]).trim();
  const base = `font-size:9px;color:#555;font-family:'Noto Sans CJK SC','Noto Sans',sans-serif;width:100%;`;
  const header = o.header
    ? `<div style="${base}padding:0 ${mh}mm;text-align:left">${escHtml(o.header)}</div>`
    : '<div></div>';
  const footer = o.pageNumbers
    ? `<div style="${base}text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
    : '<div></div>';
  return { header, footer, enabled: Boolean(o.header) || o.pageNumbers };
}

async function printPdf(chrome, htmlPath, out, o) {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'],
  }).catch(e => fail(`无法启动 Chrome：${e.message.split('\n')[0]}（可运行 --check 排查）`));
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const hf = headerFooter(o);
    await page.pdf({
      path: out, preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: hf.enabled, headerTemplate: hf.header, footerTemplate: hf.footer,
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  if (o.check) return checkEnv(o);
  if (!o.input) fail('请指定输入的 .md 文件\n\n' + USAGE);
  if (!fs.existsSync(o.input)) fail(`找不到输入文件：${o.input}`);
  try { for (const m of DEPS) require(m); }
  catch { fail('缺少依赖：请在仓库目录运行 npm install'); }
  const chrome = findChrome(o.chrome);
  if (!chrome) fail('找不到 Chrome/Chromium。请安装，或用 --chrome / CHROME_PATH 指定路径（可先运行 --check）');

  const out = path.resolve(o.output || o.input.replace(/\.(md|markdown)$/i, '') + '.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { doc, missing, mathErr } = render(o);
  const htmlPath = o.keepHtml ? out.replace(/\.pdf$/i, '') + '.html' : path.join(os.tmpdir(), `md2pdf-${process.pid}.html`);
  fs.writeFileSync(htmlPath, doc);
  try {
    await printPdf(chrome, htmlPath, out, o);
  } finally {
    if (!o.keepHtml) fs.rmSync(htmlPath, { force: true });
  }
  if (!fs.existsSync(out)) fail('没有生成 PDF');

  const size = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`已生成：${out}（${size} KB）`);
  if (missing.length) console.warn(`警告：${missing.length} 张图片没找到或格式不支持：${missing.join(', ')}`);
  if (mathErr) console.warn(`警告：有 ${mathErr} 处公式渲染失败（PDF 里会显示成红色源码）。请检查 LaTeX 语法`);
}

main().catch(e => fail(e.message));
