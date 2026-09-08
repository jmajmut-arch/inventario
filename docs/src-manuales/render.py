"""Genera los PDF de los manuales a partir de usuario.html y tecnico.html.

Uso (desde cualquier carpeta):
  python3 docs/src-manuales/render.py usuario.html ../InventIA-Manual-de-Usuario.pdf "InventIA · Manual de usuario"
  python3 docs/src-manuales/render.py tecnico.html ../InventIA-Manual-Tecnico.pdf "InventIA · Manual técnico"

Requiere Playwright para Python con Chromium (el mismo que usan los tests end-to-end).
Cada <section class="page"> es una página A4; el pie con el número de página lo pone Chromium.
"""
import os, sys
from playwright.sync_api import sync_playwright

AQUI = os.path.dirname(os.path.abspath(__file__))
src, out, titulo = sys.argv[1], sys.argv[2], sys.argv[3]
out = os.path.normpath(os.path.join(AQUI, out)) if not os.path.isabs(out) else out
chromium = os.environ.get('CHROMIUM_PATH')  # opcional; sin esto usa el Chromium de Playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, **({'executable_path': chromium} if chromium else {}))
    pg = b.new_page()
    pg.goto('file://' + os.path.join(AQUI, src))
    pg.wait_for_load_state('networkidle')
    pg.add_style_tag(content='@page{margin:0 0 11mm 0;} .page{min-height:286mm;height:286mm;overflow:hidden;} .cover{min-height:286mm;}')
    pg.emulate_media(media='print')
    pg.pdf(path=out, format='A4', print_background=True, display_header_footer=True,
           header_template='<div></div>',
           footer_template=('<div style="width:100%;font-size:7.5pt;color:#9A8E80;font-family:Liberation Sans,Arial,sans-serif;'
                            'padding:0 16mm;display:flex;justify-content:space-between;"><span>' + titulo +
                            '</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'),
           margin={'top': '0', 'bottom': '11mm', 'left': '0', 'right': '0'})
    b.close()
print('ok', out)
