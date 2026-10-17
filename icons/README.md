# Pi 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `pi.svg`：取自 Pi 官方标志 <https://pi.dev/logo.svg>（Pi 的 README 使用的同一图形），保留路径几何与三块配色
  （`#F09082`、`#4D9ABF`、`#F1BE58`）；透明底，画布 256 px。
  标志的正方形轮廓占画布边长的 55.5%、居中，与 Kimi 图标里字形（K 加蓝点）占底板的比例一致（viewBox `-22.91 -22.91 845.82 845.82`）。
  彩色图标，与 Claude 一样清单里不设 `template`，Coda 按原色显示。用于 Pi。

提取日期：2026-10-18。SVG 是可审阅的源文件，PDF 是同一组多边形的等比矢量资源（256×256，透明底），清单的 `icon` 指向 PDF。
标志全由直线多边形组成，PDF 按 SVG 的坐标手写生成；也可以照其他插件的做法用 CairoSVG 转换（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
cairosvg.svg2pdf(url='pi.svg', write_to='pi.pdf')
PY
```
