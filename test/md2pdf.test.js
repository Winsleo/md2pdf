'use strict';
/**
 * 单元测试：npm test
 * 只覆盖纯函数部分（不启动 Chrome），重点锁住 review 里发现过的回归点。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs, parseMargin, parseFontSize, normalizePaper, sanitizeFontName,
  inlineImages, sniffMime, safeDecode, buildCss, headerFooter,
  extractTitle, defaultOutput,
} = require('../md2pdf.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parseArgs: 基本位置参数与选项', () => {
  const o = parseArgs(['a.md', '-o', 'b.pdf', '--paper', 'A3', '--margin', '20,15']);
  assert.strictEqual(o.input, 'a.md');
  assert.strictEqual(o.output, 'b.pdf');
  assert.strictEqual(o.paper, 'A3');
  assert.strictEqual(o.margin, '20,15');
  assert.strictEqual(o.h1Break, true);
  assert.strictEqual(o.pageNumbers, true);
});

test('parseArgs: 支持 --opt=value 与布尔开关', () => {
  const o = parseArgs(['--paper=a5', '--margin=10', '--no-h1-break', '--no-page-numbers', '--no-html', 'x.md']);
  assert.strictEqual(o.paper, 'a5');
  assert.strictEqual(o.margin, '10');
  assert.strictEqual(o.h1Break, false);
  assert.strictEqual(o.pageNumbers, false);
  assert.strictEqual(o.html, false);
  assert.strictEqual(o.input, 'x.md');
});

test('parseArgs: 未知选项 / 缺参数 / 多个输入都要报错', () => {
  assert.throws(() => parseArgs(['--nope']), /未知选项/);
  assert.throws(() => parseArgs(['-o']), /缺少参数/);
  assert.throws(() => parseArgs(['a.md', 'b.md']), /只能指定一个输入文件/);
});

test('parseArgs: -- 之后的参数都当位置参数', () => {
  const o = parseArgs(['--', '--weird-name.md']);
  assert.strictEqual(o.input, '--weird-name.md');
});

test('parseMargin: 合法与非法输入', () => {
  assert.deepStrictEqual(parseMargin('18'), { v: 18, h: 18 });
  assert.deepStrictEqual(parseMargin('18,16'), { v: 18, h: 16 });
  assert.deepStrictEqual(parseMargin(' 18 , 16 '), { v: 18, h: 16 });
  assert.deepStrictEqual(parseMargin('12.5'), { v: 12.5, h: 12.5 });
  assert.throws(() => parseMargin('abc'), /页边距格式不对/);
  assert.throws(() => parseMargin('-5'), /页边距格式不对/);
  assert.throws(() => parseMargin('10,10,10'), /页边距格式不对/);
  assert.throws(() => parseMargin('150'), /页边距过大/);
});

test('normalizePaper / parseFontSize: 非法值直接报错，不再静默回退', () => {
  assert.strictEqual(normalizePaper('a4'), 'A4');
  assert.strictEqual(normalizePaper(' LETTER '), 'Letter');
  assert.throws(() => normalizePaper('A9'), /不支持的纸张/);
  assert.strictEqual(parseFontSize('10.5'), 10.5);
  assert.throws(() => parseFontSize('abc'), /字号不合法/);
  assert.throws(() => parseFontSize('0'), /字号不合法/);
  assert.throws(() => parseFontSize('100'), /字号不合法/);
});

test('sanitizeFontName: 去掉会破坏 CSS 的引号', () => {
  assert.strictEqual(sanitizeFontName('Noto Sans CJK SC'), 'Noto Sans CJK SC');
  assert.strictEqual(sanitizeFontName('a";}body{color:red'), 'a;}body{color:red');
});

test('safeDecode: 孤立的 % 不再抛 URIError', () => {
  assert.strictEqual(safeDecode('figs/100%.png'), 'figs/100%.png');
  assert.strictEqual(safeDecode('figs/a%20b.png'), 'figs/a b.png');
});

test('inlineImages: 双引号、单引号、缺失文件、外部地址、去重', () => {
  fs.writeFileSync(path.join(tmp, 'a.png'), PNG_1PX);
  fs.writeFileSync(path.join(tmp, 'noext'), PNG_1PX);
  const html = [
    '<img src="a.png">',
    "<img src='a.png'>",
    '<img src="missing.png">',
    '<img src="https://example.com/x.png">',
    '<img src="noext">',
  ].join('\n');
  const { html: out, missing } = inlineImages(html, tmp);

  assert.strictEqual((out.match(/data:image\/png;base64,/g) || []).length, 3, '双引号/单引号/无扩展名都应内嵌');
  assert.ok(out.includes('https://example.com/x.png'), '外链保持原样');
  assert.deepStrictEqual(missing, ['missing.png'], '只把真正缺失的报出来');
});

test('inlineImages: 原始 HTML 里带 % 的路径不再让整篇失败', () => {
  fs.writeFileSync(path.join(tmp, '100%.png'), PNG_1PX);
  const { html, missing } = inlineImages('<img src="100%.png">', tmp);
  assert.ok(html.includes('data:image/png;base64,'));
  assert.deepStrictEqual(missing, []);
});

test('sniffMime: 按文件头识别', () => {
  assert.strictEqual(sniffMime(PNG_1PX), 'image/png');
  assert.strictEqual(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.strictEqual(sniffMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.strictEqual(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.strictEqual(sniffMime(Buffer.from('hello world')), null);
});

test('buildCss: 纸张、页边距、字号、字体栈', () => {
  const css = buildCss({ paper: 'A4', marginV: 18, marginH: 16, fontSize: 10.5, h1Break: true, fontName: 'My Font' });
  assert.ok(css.includes('size:A4'));
  assert.ok(css.includes('margin:18mm 16mm'));
  assert.ok(css.includes('font-size:10.5pt'));
  assert.ok(css.includes('"My Font"'));
  assert.ok(css.includes('page-break-before:always'));
  const css2 = buildCss({ paper: 'A4', marginV: 18, marginH: 16, fontSize: 10.5, h1Break: false });
  assert.ok(!css2.includes('page-break-before:always'));
});

test('headerFooter: 页眉转义、页码开关', () => {
  const hf = headerFooter({ header: 'A<B>&"', marginH: 16, pageNumbers: true });
  assert.ok(hf.enabled);
  assert.ok(hf.header.includes('A&lt;B&gt;&amp;&quot;'));
  assert.ok(hf.footer.includes('pageNumber'));
  const none = headerFooter({ marginH: 16, pageNumbers: false });
  assert.strictEqual(none.enabled, false);
});

test('extractTitle: 跳过代码块里的 # 注释', () => {
  const src = '```bash\n# 不是标题\n```\n\n# 真标题 ##\n';
  assert.strictEqual(extractTitle(src, 'x.md'), '真标题');
  assert.strictEqual(extractTitle('没有标题', 'x.md'), 'x.md');
});

test('defaultOutput: .md/.markdown 换成 .pdf', () => {
  assert.strictEqual(defaultOutput('a.md'), 'a.pdf');
  assert.strictEqual(defaultOutput('dir/a.MARKDOWN'), 'dir/a.pdf');
  assert.strictEqual(defaultOutput('a.txt'), 'a.txt.pdf');
});
