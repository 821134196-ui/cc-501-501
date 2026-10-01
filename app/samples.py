"""生成图纸样例(SVG,尺寸单位为 mm),含比例错误演示样例。

图纸元数据(页数/字体/图层)内嵌在 <metadata id="drawing-meta"> 中,
上传预检会解析它,模拟真实 CAD 输出文件的检查过程。
"""
import json
import os


def _frame(w, h):
    """图框 + 标题栏。"""
    m = 10 if min(w, h) > 300 else 5
    parts = [
        f'<rect x="{m}" y="{m}" width="{w-2*m}" height="{h-2*m}" fill="none" stroke="#334155" stroke-width="1.2"/>',
        f'<rect x="{m+3}" y="{m+3}" width="{w-2*m-6}" height="{h-2*m-6}" fill="none" stroke="#334155" stroke-width="0.4"/>',
    ]
    # 标题栏(右下)
    tw, th = 120, 32
    x0, y0 = w - m - 3 - tw, h - m - 3 - th
    parts.append(f'<rect x="{x0}" y="{y0}" width="{tw}" height="{th}" fill="none" stroke="#334155" stroke-width="0.6"/>')
    parts.append(f'<line x1="{x0}" y1="{y0+th/2}" x2="{x0+tw}" y2="{y0+th/2}" stroke="#334155" stroke-width="0.4"/>')
    return parts, (x0, y0, tw, th)


def _dims(x, y, length, label):
    """一条水平尺寸线。"""
    return [
        f'<line x1="{x}" y1="{y}" x2="{x+length}" y2="{y}" stroke="#64748b" stroke-width="0.35"/>',
        f'<line x1="{x}" y1="{y-2}" x2="{x}" y2="{y+2}" stroke="#64748b" stroke-width="0.35"/>',
        f'<line x1="{x+length}" y1="{y-2}" x2="{x+length}" y2="{y+2}" stroke="#64748b" stroke-width="0.35"/>',
        f'<text x="{x+length/2}" y="{y-2.5}" font-size="5" text-anchor="middle" fill="#475269">{label}</text>',
    ]


def make_drawing(width_mm, height_mm, title, drawing_no, scale_label,
                 pages, fonts, layers, body_kind="plan"):
    """生成一张工程图 SVG 文本。"""
    frame, (tx, ty, tw, th) = _frame(width_mm, height_mm)
    body = []
    cx, cy = width_mm / 2, height_mm / 2
    if body_kind == "plan":
        # 平面布置:外墙 + 隔墙 + 门窗开口
        rw, rh = width_mm * 0.55, height_mm * 0.5
        x0, y0 = cx - rw / 2, cy - rh / 2 - 10
        body += [
            f'<rect x="{x0}" y="{y0}" width="{rw}" height="{rh}" fill="none" stroke="#1e293b" stroke-width="1.6"/>',
            f'<line x1="{x0+rw*0.4}" y1="{y0}" x2="{x0+rw*0.4}" y2="{y0+rh*0.62}" stroke="#1e293b" stroke-width="0.9"/>',
            f'<line x1="{x0+rw*0.4}" y1="{y0+rh*0.62}" x2="{x0+rw}" y2="{y0+rh*0.62}" stroke="#1e293b" stroke-width="0.9"/>',
            f'<rect x="{x0+rw*0.12}" y="{y0+rh*0.12}" width="{rw*0.16}" height="{rh*0.2}" fill="none" stroke="#475569" stroke-width="0.5"/>',
            f'<circle cx="{x0+rw*0.72}" cy="{y0+rh*0.3}" r="{min(rw,rh)*0.09}" fill="none" stroke="#475569" stroke-width="0.5"/>',
        ]
        body += _dims(x0, y0 + rh + 12, rw, f"{int(rw*10)}")
        body += _dims(x0, y0 - 8, rw * 0.4, f"{int(rw*4)}")
    elif body_kind == "site":
        # 总平面:用地红线 + 建筑轮廓 + 道路
        body += [
            f'<rect x="{width_mm*0.12}" y="{height_mm*0.12}" width="{width_mm*0.76}" height="{height_mm*0.66}"'
            f' fill="none" stroke="#b91c1c" stroke-width="0.8" stroke-dasharray="8,3"/>',
            f'<rect x="{width_mm*0.3}" y="{height_mm*0.25}" width="{width_mm*0.28}" height="{height_mm*0.2}"'
            f' fill="none" stroke="#1e293b" stroke-width="1.4"/>',
            f'<rect x="{width_mm*0.62}" y="{height_mm*0.5}" width="{width_mm*0.16}" height="{height_mm*0.14}"'
            f' fill="none" stroke="#1e293b" stroke-width="1.0"/>',
            f'<path d="M {width_mm*0.12} {height_mm*0.86} Q {width_mm*0.5} {height_mm*0.7} {width_mm*0.88} {height_mm*0.88}"'
            f' fill="none" stroke="#64748b" stroke-width="2.2"/>',
        ]
        body += _dims(width_mm * 0.12, height_mm * 0.84, width_mm * 0.76, f"{int(width_mm*0.76*20)}")
    else:  # part 零件图
        body += [
            f'<circle cx="{cx}" cy="{cy-10}" r="{height_mm*0.22}" fill="none" stroke="#1e293b" stroke-width="1.2"/>',
            f'<circle cx="{cx}" cy="{cy-10}" r="{height_mm*0.1}" fill="none" stroke="#1e293b" stroke-width="0.8"/>',
            f'<line x1="{cx-height_mm*0.28}" y1="{cy-10}" x2="{cx+height_mm*0.28}" y2="{cy-10}"'
            f' stroke="#64748b" stroke-width="0.3" stroke-dasharray="6,2,1,2"/>',
            f'<line x1="{cx}" y1="{cy-10-height_mm*0.28}" x2="{cx}" y2="{cy-10+height_mm*0.28}"'
            f' stroke="#64748b" stroke-width="0.3" stroke-dasharray="6,2,1,2"/>',
        ]
        body += _dims(cx - height_mm * 0.22, cy + height_mm * 0.22, height_mm * 0.44, f"Φ{int(height_mm*0.44*2)}")

    meta = {"pages": pages, "fonts": fonts, "layers": layers}
    layer_text = " ".join(f"[{l['name']}{'' if l.get('print', True) else '·不打印'}]" for l in layers)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width_mm}mm" height="{height_mm}mm"
 viewBox="0 0 {width_mm} {height_mm}" font-family="HZTXT, SimSun, sans-serif">
<metadata id="drawing-meta">{json.dumps(meta, ensure_ascii=False)}</metadata>
<rect x="0" y="0" width="{width_mm}" height="{height_mm}" fill="#ffffff"/>
{chr(10).join(frame)}
{chr(10).join(body)}
<text x="{tx+4}" y="{ty+th*0.32}" font-size="6" fill="#1e293b">{title}</text>
<text x="{tx+4}" y="{ty+th*0.82}" font-size="4.5" fill="#475569">图号 {drawing_no}　比例 {scale_label}　共{pages}页</text>
<text x="{tx+tw*0.55}" y="{ty+th*0.32}" font-size="4.5" fill="#475569">{layer_text}</text>
<text x="{tx+tw*0.55}" y="{ty+th*0.82}" font-size="4.5" fill="#475569">字体:{"、".join(fonts)}</text>
</svg>'''
    return svg


SAMPLES = {
    "a1-floor-plan.svg": dict(
        width_mm=841, height_mm=594, title="一层平面布置图", drawing_no="A-101",
        scale_label="1:100", pages=1, fonts=["HZTXT", "SimSun"],
        layers=[{"name": "墙体", "print": True}, {"name": "尺寸", "print": True}],
        body_kind="plan"),
    "a1-site-plan.svg": dict(
        width_mm=841, height_mm=594, title="厂区总平面图", drawing_no="S-001",
        scale_label="1:500", pages=1, fonts=["HZTXT"],
        layers=[{"name": "红线", "print": True}, {"name": "道路", "print": True}],
        body_kind="site"),
    "a3-mech-part.svg": dict(
        width_mm=420, height_mm=297, title="传动轴零件图", drawing_no="M-208",
        scale_label="1:2", pages=1, fonts=["HZTXT", "ArchFont-X"],
        layers=[{"name": "轮廓", "print": True}, {"name": "中心线", "print": True},
                {"name": "工艺备注", "print": False}],
        body_kind="part"),
    "a4-node-detail.svg": dict(
        width_mm=297, height_mm=210, title="节点大样图", drawing_no="D-330",
        scale_label="1:20", pages=2, fonts=["SimSun", "GBCBIG"],
        layers=[{"name": "构造", "print": True}],
        body_kind="part"),
}


def generate_samples(sample_dir):
    """生成全部样例图纸,返回文件名列表。幂等:已存在则覆盖为最新内容。"""
    os.makedirs(sample_dir, exist_ok=True)
    names = []
    for name, kw in SAMPLES.items():
        svg = make_drawing(**kw)
        with open(os.path.join(sample_dir, name), "w", encoding="utf-8") as f:
            f.write(svg)
        names.append(name)
    return names
