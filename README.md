# md2pdf

把 **Markdown（含 LaTeX 公式、表格、图片）** 一条命令转成排版好的 **PDF**。
中文友好，不需要安装 LaTeX 或 pandoc。

```bash
node md2pdf.js 报告.md            # 生成 报告.pdf
```

适合：课程作业、实验报告、技术文档——用 Markdown 写，交 PDF。

---

## 目录

1. [原理](#1-原理)
2. [快速开始](#2-快速开始)
3. [命令行参数](#3-命令行参数)
4. [Markdown 写法要点](#4-markdown-写法要点)
5. [自定义样式](#5-自定义样式)
6. [在新机器上安装](#6-在新机器上安装)
7. [常见问题](#7-常见问题)
8. [已知限制](#8-已知限制)
9. [目录结构](#9-目录结构)

---

## 1. 原理

```
.md ──markdown-it──► HTML ──KaTeX──► 公式渲染好的 HTML
                                          │  图片、KaTeX 字体全部内嵌（base64）
                                          ▼
                              自包含的单个 HTML 文件
                                          │  puppeteer-core 驱动系统 Chrome，page.pdf()
                                          ▼
                                  PDF（带页码、可选页眉）
```

- **markdown-it**：解析 Markdown；**markdown-it-texmath + KaTeX**：把 `$...$` 和 `$$...$$` 渲染成排版好的公式。
- 图片和 KaTeX 字体内嵌进 HTML，所以中间文件不依赖外部路径，Chrome 打印时不会丢图。
- 最后用 **puppeteer-core** 驱动你电脑上已有的 Chrome 打印：它只是控制浏览器的库，**不会另外下载浏览器**。分页、字体回退、中文排版由浏览器完成，页码和页眉由 Puppeteer 的页眉页脚模板生成。

## 2. 快速开始

仓库里已经带了依赖（`node_modules/`），在这台机器上可以直接用。

```bash
cd ~/Code/md2pdf

node md2pdf.js --check                              # 1. 检查环境（第一次用先跑一下）
node md2pdf.js examples/demo.md -o /tmp/demo.pdf    # 2. 试一下示例
node md2pdf.js /path/to/报告.md                      # 3. 转自己的文档，PDF 与 .md 同目录
```

常用组合：

```bash
node md2pdf.js 报告.md -o ~/Desktop/最终版.pdf      # 指定输出位置
node md2pdf.js 报告.md --no-h1-break                # 一级标题前不强制换页
node md2pdf.js 报告.md --margin 15,12 --font-size 11  # 页边距 15mm/12mm，字号 11pt
node md2pdf.js 报告.md --header "张三 000000　某某课程作业"   # 每页加页眉
node md2pdf.js 报告.md --no-page-numbers            # 不要页码（默认有）
```

输出示例：

```
已生成：/tmp/demo.pdf（274 KB）
警告：1 张图片没找到或格式不支持：nope.png      ← 有问题会在这里提示
警告：有 1 处公式渲染失败（PDF 里会显示成红色源码）。请检查 LaTeX 语法
```

转换后建议**目视检查**一遍排版，可以用预览脚本把每页导成 PNG：

```bash
scripts/preview.sh 报告.pdf            # 输出到 报告_preview/page-01.png ...
```

## 3. 命令行参数

```
node md2pdf.js <input.md> [选项]
```

| 选项 | 说明 | 默认 |
|---|---|---|
| `-o, --output <file.pdf>` | 输出文件 | 与输入同名、同目录的 `.pdf` |
| `--paper <A4\|A3\|Letter\|Legal>` | 纸张大小 | `A4` |
| `--margin <mm>` | 页边距：一个数字，或 `上下,左右` | `18,16` |
| `--font-size <pt>` | 正文字号 | `10.5` |
| `--font <字体名>` | 正文字体，放在字体栈最前（需要系统里装有） | 自动：Noto Serif CJK SC → Noto Sans CJK SC → 思源宋体 → 宋体/苹方/微软雅黑 → 文泉驿 |
| `--css <file.css>` | 追加自定义 CSS，可覆盖默认样式 | 无 |
| `--title <文字>` | PDF 文档标题 | 第一个 `#` 标题 |
| `--no-h1-break` | 一级标题前不强制换页 | 默认每个 `#` 前换页 |
| `--no-page-numbers` | 不要页码 | 默认页脚居中显示“当前页 / 总页数” |
| `--header <文字>` | 每页页眉文字，靠左，小号灰字 | 无 |
| `--keep-html` | 保留中间生成的 HTML（与 PDF 同名）| 不保留 |
| `--chrome <path>` | 指定 Chrome/Chromium 可执行文件 | 自动查找，或读环境变量 `CHROME_PATH` |
| `--check` | 检查环境后退出 | — |
| `-h, --help` | 帮助 | — |

退出码：成功为 0，出错为 1（找不到文件、缺依赖、找不到或启动不了 Chrome）。`--chrome` / `CHROME_PATH` 一旦指定就只认它，路径不对会直接报错，不会悄悄换成别的浏览器。

也可以用 npm 脚本：`npm run pdf -- 报告.md`、`npm run check`、`npm run demo`。

## 4. Markdown 写法要点

完整示例见 [`examples/demo.md`](examples/demo.md)。

**公式**

| 写法 | 效果 |
|---|---|
| `$e^{i\pi}+1=0$` | 行内公式 |
| `$$ ... $$`（独占段落） | 独立公式，居中 |
| `\begin{aligned} ... \\ ... \end{aligned}` 放在 `$$` 里 | 多行对齐 |

- 公式里用 KaTeX 支持的 LaTeX 语法（[支持列表](https://katex.org/docs/supported.html)）。写错的公式不会让转换失败，而是在 PDF 里显示成红色源码，并在终端警告。
- 文中想写真正的美元符号（如价格），用 `\$`。
- 公式里的 `|` 在表格单元格中会被当作列分隔符；表格里写绝对值/范数请用 `\vert`、`\Vert`。

**图片**

```markdown
![图 1 说明文字](figs/result.png)
```

- 路径相对于 `.md` 文件所在目录；支持 png / jpg / gif / svg / webp。
- 路径里有中文、空格都可以（空格建议写成 `%20`）。
- 图片会内嵌进 PDF，超过页宽的会自动缩小。

**表格、列表、代码块、引用**：使用标准 Markdown（GFM）写法即可。表格不会跨页拆开；超长表格建议拆成两张。

**分页**

- 每个一级标题 `#` 默认另起一页（适合“Q1 / Q2 / P1”这种每题一页起的作业）；不想要就加 `--no-h1-break`。
- 标题不会孤零零落在页底（已设置“标题后不分页”）。
- 需要手动强制分页时，在 Markdown 里写：`<div style="page-break-after: always"></div>`

## 5. 自定义样式

用 `--css` 追加一份样式覆盖默认值。例如 `my.css`：

```css
body { font-family: "Noto Sans CJK SC", sans-serif; font-size: 11pt; }
h1   { border-bottom: none; color: #1a4f8b; }
table { font-size: 10pt; }
```

```bash
node md2pdf.js 报告.md --css my.css
```

默认样式写在 `md2pdf.js` 的 `buildCss()` 里，想永久改默认值就改那里。

## 6. 在新机器上安装

需要三样东西：

| 依赖 | 说明 | 安装（Ubuntu 示例）|
|---|---|---|
| Node.js ≥ 18 | 运行脚本 | `sudo apt install nodejs npm` |
| Chrome 或 Chromium | 打印 PDF（由 puppeteer-core 驱动，不会自动下载浏览器） | `sudo apt install chromium` 或安装 Google Chrome |
| 中文字体 | 否则中文显示成方块 | `sudo apt install fonts-noto-cjk` |

macOS 和 Windows 系统自带中文字体；Chrome 在常见安装路径会被自动找到。

```bash
git clone <本仓库> md2pdf && cd md2pdf     # 或直接把整个目录拷过去
npm install                                  # 若拷贝时带了 node_modules 则不需要
node md2pdf.js --check                       # 全部 [ OK ] 即可使用
```

想在任意目录直接敲 `md2pdf 报告.md`：

```bash
npm link          # 在仓库目录执行一次
md2pdf 报告.md
```

依赖版本已锁定（`package.json` + `package-lock.json`）：markdown-it 15.0.3、katex 0.19.1、markdown-it-texmath 1.0.0、puppeteer-core 24.43.1（支持 Node 18+）。

## 7. 常见问题

**中文显示成方块 / 字体不对**
→ 系统缺中文字体。Linux 装 `fonts-noto-cjk`（`--check` 会提示）；或用 `--font "你的字体名"` 指定一个系统里有的字体（`fc-list :lang=zh` 可查看）。

**公式显示成红色源码**
→ LaTeX 语法错误或用了 KaTeX 不支持的命令。终端会提示有几处。常见原因：括号没配对；用了 `\begin{equation}` 之类的环境（改用 `$$ ... $$` 或 `aligned`）；表格里公式含 `|`。

**公式没被识别，原样显示 `$...$`**
→ 美元符号和公式之间不要留空格：`$x$` 对，`$ x $` 不行。

**图片没出现**
→ 终端会警告“张图片没找到”。检查路径是否相对 `.md` 文件，文件名大小写是否一致（Linux 区分大小写）。

**提示“找不到 Chrome/Chromium”**
→ 运行 `--check` 看查找结果；已安装但不在常见位置时：`node md2pdf.js 报告.md --chrome /你的/chrome` 或 `export CHROME_PATH=...`。

**提示“无法启动 Chrome”**
→ 先运行 `--check` 看 Chrome 是否被找到。常见原因：Chrome 版本太老（建议 Chrome 120 以上）、`--chrome` 指到了不是 Chrome 的程序、系统缺少 Chrome 运行所需的库（在最小化的 Linux 容器里常见，装 Chromium 的完整包通常能解决）。输出目录没有写权限也会失败。

**标题孤零零落在页底 / 页面底部有大块空白**
→ 标题已经设置了“不与下文分开”；大块空白通常是因为接下来是一张大图或表格（它们设置了“不跨页拆开”）。可以调小图片、拆分表格，或用 `--margin` 调整页边距。

**第一页只有标题和一点内容，后面直接换页**
→ 这是“每个 `#` 另起一页”的效果。加 `--no-h1-break` 即可。

**PDF 比预期大**
→ 图片以原分辨率内嵌。可以先用图像工具压缩 PNG，或把截图改存为 JPEG。

## 8. 已知限制

- **页脚样式固定**：页码只能是居中的“当前页 / 总页数”，页眉只有一段靠左文字；要改样式，修改 `md2pdf.js` 里的 `headerFooter()`（Puppeteer 的页眉页脚模板是一小段内联样式的 HTML）。
- **首页也有页码**：没有“封面不编号”的开关。
- **分页由 Chrome 决定**：和 Word 一样，没有“精确控制”，需要时用手动分页符。
- **公式只支持 KaTeX 子集**：绝大多数常见数学写法都支持；TikZ、`\newcommand` 复杂宏等不支持。
- **不会自动生成目录**（TOC）。
- **图片需在本地**：`http(s)://` 图片不会被内嵌（需要联网才能显示）。

## 9. 目录结构

```
md2pdf/
├── md2pdf.js          # 命令行主程序（全部逻辑，约 250 行）
├── package.json       # 依赖与 npm 脚本
├── package-lock.json  # 依赖版本锁定
├── node_modules/      # 依赖（约 65 MB，已放好，可 npm install 重建）
├── examples/
│   ├── demo.md        # 功能演示：公式、表格、图片、代码
│   └── demo.png
├── scripts/
│   └── preview.sh     # PDF → 每页 PNG，用于检查排版（需要 poppler-utils）
├── LICENSE
└── README.md          # 本手册
```
