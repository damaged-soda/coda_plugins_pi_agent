# Pi 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `pi.svg`：取自 Pi 官方标志 <https://pi.dev/logo.svg>（Pi 的 README 使用的同一图形），保留路径几何与三块配色
  （`#F09082`、`#4D9ABF`、`#F1BE58`）；只把画布从 800×800 裁成贴合标志的正方形并定为 256 px，透明底。
  彩色图标，与 Claude 一样清单里不设 `template`，Coda 按原色显示。用于 Pi。

提取日期：2026-10-18。SVG 是可审阅的源文件，PDF 是同一组多边形的等比矢量资源（256×256，透明底），清单的 `icon` 指向 PDF。
标志全由直线多边形组成，PDF 按 SVG 的坐标手写生成；也可以照其他插件的做法用 CairoSVG 转换（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
cairosvg.svg2pdf(url='pi.svg', write_to='pi.pdf')
PY
```
