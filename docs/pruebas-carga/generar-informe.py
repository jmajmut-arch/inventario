#!/usr/bin/env python3
"""Arma el informe de una hoja (carta) de las pruebas de carga desde datos.json.

Uso:  python3 generar-informe.py            -> informe-carga.html
      NODE_PATH=/opt/node22/lib/node_modules node ../comercial/render-one-page.js ../pruebas-carga/informe-carga
Las fuentes y el logo se toman del one page comercial, para no duplicarlos en el repo.
"""
import json, math, re, html
from pathlib import Path

AQUI = Path(__file__).resolve().parent
d = json.loads((AQUI / 'datos.json').read_text(encoding='utf-8'))
onepage = (AQUI.parent / 'comercial' / 'one-page-inventario.html').read_text(encoding='utf-8')
fuentes = ''.join(re.findall(r'@font-face\{[^}]*\}', onepage))
logo = re.search(r'<img[^>]*src="(data:image/[^"]+)"', onepage).group(1)

# Una corrida por prueba, en orden; la última es la que se destaca.
CORRIDAS = d['corridas']
niveles = sorted({n['personas'] for c in CORRIDAS for n in c['niveles']})
GRID, TXT, BUENO = '#ece4d3', '#5f5142', '#3f7d4f'

def fmt_ms(v):
    if v is None: return '—'
    if v >= 1000: return (f'{v/1000:.1f}'.rstrip('0').rstrip('.').replace('.', ',') if v < 10000 else f'{v/1000:.0f}') + ' s'
    return f'{v:.0f} ms'

def serie(run, clave):
    m = {n['personas']: n.get(clave) for n in run['niveles']}
    return [m.get(p) for p in niveles]

def grafico_log(titulo, clave, sub, umbral=None, w=300, h=175):
    """Líneas antes/después en escala logarítmica de tiempo (100 ms a 60 s)."""
    l, r, t, b = 40, 10, 8, 26
    lo, hi = math.log10(100), math.log10(60000)
    X = lambda i: l + (w - l - r) * i / (len(niveles) - 1)
    Y = lambda v: t + (h - t - b) * (1 - (math.log10(max(min(v, 60000), 100)) - lo) / (hi - lo))
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(titulo)}">']
    for v, et in [(100,'100 ms'),(300,'300 ms'),(1000,'1 s'),(3000,'3 s'),(10000,'10 s'),(60000,'60 s')]:
        y = Y(v)
        out.append(f'<line x1="{l}" x2="{w-r}" y1="{y:.1f}" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{l-4}" y="{y+3:.1f}" text-anchor="end" class="ax">{et}</text>')
    if umbral:
        y = Y(umbral)
        out.append(f'<line x1="{l}" x2="{w-r}" y1="{y:.1f}" y2="{y:.1f}" stroke="{BUENO}" stroke-width="1.2" stroke-dasharray="4 3"/>')
    for i, p in enumerate(niveles):
        out.append(f'<text x="{X(i):.1f}" y="{h-12}" text-anchor="middle" class="ax">{p}</text>')
    out.append(f'<text x="{(l+w-r)/2:.1f}" y="{h-1}" text-anchor="middle" class="ax">personas contando a la vez</text>')
    for k, run in enumerate(CORRIDAS):
        col, ancho = run['color'], (2.4 if k == len(CORRIDAS) - 1 else 1.6)
        vals = serie(run, clave)
        pts = [(X(i), Y(v)) for i, v in enumerate(vals) if v is not None]
        out.append('<polyline fill="none" stroke="%s" stroke-width="%s" stroke-linejoin="round" points="%s"/>'
                   % (col, ancho, ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)))
        for x, y in pts:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{col}"/>')
    out.append('</svg>')
    return f'<figure class="card graf"><figcaption><b>{titulo}</b><span>{sub}</span></figcaption>{"".join(out)}</figure>'

def grafico_barras(titulo, clave, sub, maximo, sufijo, w=300, h=175, dec=1):
    l, r, t, b = 40, 10, 8, 26
    X0 = lambda i: l + (w - l - r) * i / len(niveles)
    paso = (w - l - r) / len(niveles)
    Y = lambda v: t + (h - t - b) * (1 - min(v, maximo) / maximo)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(titulo)}">']
    for k in range(5):
        v = maximo * k / 4; y = Y(v)
        out.append(f'<line x1="{l}" x2="{w-r}" y1="{y:.1f}" y2="{y:.1f}" stroke="{GRID}"/>')
        out.append(f'<text x="{l-4}" y="{y+3:.1f}" text-anchor="end" class="ax">{v:.0f}{sufijo}</text>')
    vals = [serie(run, clave) for run in CORRIDAS]
    for i, p in enumerate(niveles):
        x = X0(i); bw = paso * 0.8 / len(CORRIDAS) - 1
        for j, run in enumerate(CORRIDAS):
            v, col = vals[j][i], run['color']
            if v is None: continue
            xx = x + paso * 0.1 + j * (bw + 1)
            y = Y(v)
            out.append(f'<rect x="{xx:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{(Y(0)-y):.1f}" fill="{col}" rx="1"/>')
            if v >= 10:
                txt = (f'{v:.{dec}f}'.rstrip('0').rstrip('.') if dec else f'{v:.0f}').replace('.', ',')
                out.append(f'<text x="{xx+bw/2:.1f}" y="{y-2:.1f}" text-anchor="middle" class="vb" fill="{col}">{txt}</text>')
        out.append(f'<text x="{x+paso/2:.1f}" y="{h-12}" text-anchor="middle" class="ax">{p}</text>')
    out.append(f'<text x="{(l+w-r)/2:.1f}" y="{h-1}" text-anchor="middle" class="ax">personas contando a la vez</text>')
    out.append('</svg>')
    return f'<figure class="card graf"><figcaption><b>{titulo}</b><span>{sub}</span></figcaption>{"".join(out)}</figure>'

def tabla():
    pct = lambda v: (f'{v:.2f}%'.replace('.00%', '%').replace('.', ',') if v else '0%')
    metricas = [('err', 'Errores', pct), ('guardar', 'Guardar un conteo (p95)', fmt_ms), ('dashboard', 'Dashboard (p95)', fmt_ms)]
    ult = len(CORRIDAS) - 1
    filas = []
    for p in niveles:
        celdas = ''
        for clave, _, f in metricas:
            for k, run in enumerate(CORRIDAS):
                fila = next((n for n in run['niveles'] if n['personas'] == p), None)
                v = fila.get(clave) if fila else None
                txt = f(v) if fila and (v is not None or clave == 'err') else '—'
                celdas += f'<td class="{"b" if k == ult else "a"}">{txt}</td>'
        filas.append(f'<tr><th>{p}</th>{celdas}</tr>')
    cab = ''.join(f'<th colspan="{len(CORRIDAS)}">{t}</th>' for _, t, _ in metricas)
    sub = '<th></th>' + ''.join(f'<th class="{"b" if k == ult else "a"}">{run["corta"]}</th>' for k, run in enumerate(CORRIDAS)) * len(metricas)
    return f'<table><thead><tr><th>Personas</th>{cab}</tr><tr class="sub">{sub}</tr></thead><tbody>{"".join(filas)}</tbody></table>'

kpis = ''.join(f'<div class="kpi"><div class="q">{k["q"]}</div><div class="a">{k["a"]}</div><div class="n">{k["n"]}</div></div>' for k in d['kpis'])
conclusiones = ''.join(f'<li>{c}</li>' for c in d['conclusiones'])
mejoras = ''.join(f'<tr><td>{m[0]}</td><td class="num">{m[1]}</td><td class="num b">{m[2]}</td></tr>' for m in d['mejoras'])

pagina = f'''<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>InventIA · Pruebas de carga {d["fecha"]}</title>
<style>
{fuentes}
:root{{--text:#241a10;--dim:#5f5142;--faint:#8a7a68;--amber:#bd5b2c;--amber-dim:#8c4520;--line:#e7dcc4;--good:#3f7d4f;--ink:#1e2a30}}
@page{{size:letter;margin:0}}
html{{background:#d9d2c4}}
body{{margin:0;background:#fff;color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:8.6pt;line-height:1.33;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.page{{width:215.9mm;height:279.4mm;margin:0 auto;background:#fff;box-sizing:border-box;padding:6.5mm 11mm 5.5mm;display:flex;flex-direction:column;gap:2.6mm;overflow:hidden}}
@media screen{{.page{{box-shadow:0 10px 40px rgba(0,0,0,.18);margin:18px auto}}}}
@media print{{html{{background:#fff}}.page{{box-shadow:none;margin:0}}}}
h1,h2{{margin:0;font-family:'Barlow Condensed','Arial Narrow',sans-serif}}
.hdr{{display:flex;align-items:center;gap:4mm;border-bottom:2px solid var(--ink);padding-bottom:2.4mm}}
.hdr img{{width:12mm;height:12mm;border-radius:3.4mm}}
.hdr h1{{font-size:21pt;font-weight:800;line-height:1;color:var(--ink)}}
.hdr h1 em{{font-style:normal;color:var(--amber)}}
.hdr .tag{{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:12pt;margin-top:.6mm}}
.hdr .meta{{margin-left:auto;text-align:right;color:var(--dim);font-size:8pt;line-height:1.45}}
.hdr .meta b{{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10.5pt;color:var(--amber-dim);letter-spacing:.6px;text-transform:uppercase}}
.eyebrow{{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9.6pt;letter-spacing:1.1px;text-transform:uppercase;color:var(--amber-dim);margin-bottom:1mm}}
.lead{{font-size:9.4pt;font-weight:500;line-height:1.34}}
.lead b{{color:var(--amber-dim)}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:2.6mm}}
.kpi{{background:var(--ink);color:#f4efe6;border-radius:2mm;padding:2.2mm 2.8mm;display:flex;flex-direction:column;gap:.6mm}}
.kpi .q{{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:9.4pt;color:#d8cdb9;line-height:1.1}}
.kpi .a{{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:17pt;line-height:1;color:#fff}}
.kpi .a span{{color:#f0a06b}}
.kpi .n{{font-size:7.4pt;color:#cfc4b1;line-height:1.25}}
.card{{border:1px solid var(--line);border-radius:2mm;padding:2mm 2.6mm}}
.grid2{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2.4mm}}
.graf{{margin:0}}
.graf figcaption{{display:flex;flex-direction:column;margin-bottom:.6mm}}
.graf figcaption b{{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:11pt;color:var(--ink)}}
.graf figcaption span{{font-size:7.4pt;color:var(--faint)}}
.graf svg{{width:100%;height:auto;display:block}}
.ax{{font-family:'IBM Plex Mono',monospace;font-size:9px;fill:{TXT}}}
.vb{{font-family:'IBM Plex Mono',monospace;font-size:8.6px;font-weight:500}}
.leyenda{{display:flex;flex-wrap:wrap;gap:1mm 4.5mm;align-items:center;font-size:7.8pt;color:var(--dim)}}
.leyenda i{{display:inline-block;width:5mm;height:1.6mm;border-radius:1mm;margin-right:1.4mm;vertical-align:middle}}
.leyenda .u{{display:inline-block;width:5mm;border-top:1.4px dashed var(--good);margin-right:1.4mm;vertical-align:middle}}
table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:7.6pt}}
th,td{{padding:.75mm 1.1mm;text-align:right;border-bottom:1px solid #f1eadb;white-space:nowrap}}
thead th{{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:8.6pt;color:var(--ink);text-align:center;border-bottom:none}}
thead tr.sub th{{font-family:'Inter',sans-serif;font-weight:500;font-size:6.8pt;color:var(--faint);border-bottom:1px solid var(--line)}}
tbody th{{text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:9.4pt}}
td.a{{color:var(--faint)}} td.b,th.b{{color:var(--amber-dim);font-weight:600}}
.cols{{display:grid;grid-template-columns:1.35fr 1fr;gap:2.6mm}}
ul{{margin:0;padding-left:4mm}} li{{margin:.5mm 0}}
.mej td{{border-bottom:1px solid #f1eadb}} .mej td:first-child{{text-align:left;white-space:normal}}
.num{{font-family:'IBM Plex Mono',monospace;font-size:7.6pt}}
.nota{{font-size:7.2pt;color:var(--faint);line-height:1.3;margin-top:auto}}
</style></head><body><div class="page">
<header class="hdr"><img src="{logo}" alt="">
<div><h1>Invent<em>IA</em> · pruebas de carga</h1><div class="tag">{d["subtitulo"]}</div></div>
<div class="meta"><b>{d["fecha"]}</b>{d["meta"]}</div></header>
<p class="lead">{d["resumen"]}</p>
<div class="kpis">{kpis}</div>
<div class="leyenda">{"".join(f'<span><i style="background:{c["color"]}"></i>{c["etiqueta"]}</span>' for c in CORRIDAS)}<span><span class="u"></span>1 s</span></div>
<div class="grid2">
{grafico_log("Guardar un conteo", "guardar", "p95, escala logarítmica", umbral=1000)}
{grafico_log("Abrir el Dashboard", "dashboard", "p95, escala logarítmica", umbral=1000)}
{grafico_barras("Peticiones con error", "err", "% de peticiones fallidas o cortadas a 60 s", d.get("max_err", 50), "%")}
</div>
<div class="card"><div class="eyebrow">Resultado por nivel</div>{tabla()}</div>
<div class="cols">
<div class="card"><div class="eyebrow">Qué significa</div><ul>{conclusiones}</ul></div>
<div class="card"><div class="eyebrow">Mejoras de hoy (servidor, Escondida)</div><table class="mej"><thead><tr><th style="text-align:left">Consulta</th><th>Antes</th><th>Ahora</th></tr></thead><tbody>{mejoras}</tbody></table></div>
</div>
<p class="nota">{d["metodo"]}</p>
</div></body></html>'''
(AQUI / 'informe-carga.html').write_text(pagina, encoding='utf-8')
print('ok', len(pagina))
