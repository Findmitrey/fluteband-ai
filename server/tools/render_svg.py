#!/usr/bin/env python3
"""FluteBand AI — рендер нотного текста в SVG (гравировка verovio, свободная лицензия).

Нужен для проверки распознавания: у нас есть эталонный MusicXML, мы делаем из него
«печатную страницу», прогоняем через OMR и сравниваем результат с эталоном.

Запуск:
    python server/tools/render_svg.py вход.musicxml выход.svg [--scale=40] [--page=1]
Вывод: JSON с размерами страницы (нужны, чтобы растеризовать SVG в PNG без обрезки).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Пакеты движка лежат в server/deps (установка без venv: pip install --target server/deps)
DEPS = Path(__file__).resolve().parents[1] / "deps"
if DEPS.exists():
    sys.path.insert(0, str(DEPS))

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a.split("=")[0]: a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
    if len(args) < 2:
        print("Использование: python server/tools/render_svg.py вход.musicxml выход.svg [--scale=40] [--page=1]")
        return 2

    source, target = Path(args[0]), Path(args[1])
    scale = int(flags.get("--scale", "50"))
    page = int(flags.get("--page", "1")) - 1
    # По умолчанию — полноразмерная страница (как лист из сборника).
    # Важно: Chrome отдаёт пустой снимок при слишком маленькой высоте окна,
    # поэтому обрезать страницу по высоте (adjustPageHeight) не годится для стенда.
    full_page = flags.get("--full-page", "1") not in ("0", "false", "no")

    import verovio

    toolkit = verovio.toolkit()
    data_dir = DEPS / "verovio" / "data"
    if data_dir.exists():
        toolkit.setResourcePath(str(data_dir))
    toolkit.setOptions({
        "scale": scale,
        "pageWidth": int(flags.get("--page-width", "2400")),      # ~A4 при scale=50
        "pageHeight": int(flags.get("--page-height", "3300")),
        "adjustPageHeight": not full_page,
        "footer": "none",
        "header": "none",
        "breaks": flags.get("--breaks", "auto"),
    })
    if not toolkit.loadData(source.read_text(encoding="utf-8")):
        print(json.dumps({"ok": False, "error": "verovio не смог разобрать MusicXML"}, ensure_ascii=False))
        return 1

    pages = toolkit.getPageCount()
    # ВНИМАНИЕ: в verovio 6.x нумерация страниц 1-базовая.
    # Вызов renderToSVG(0) приводит к падению процесса (access violation), а не к ошибке Python.
    page_number = max(1, min(page + 1, pages))
    svg = toolkit.renderToSVG(page_number)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(svg, encoding="utf-8")

    # Размеры страницы берём из самого SVG: в verovio 6.x getSVGWidth/getSVGHeight недоступны
    import re

    header = svg[:400]
    width = re.search(r'width="([\d.]+)', header)
    height = re.search(r'height="([\d.]+)', header)

    print(json.dumps({
        "ok": True,
        "pages": pages,
        "page": page_number,
        "width": int(float(width.group(1))) if width else None,
        "height": int(float(height.group(1))) if height else None,
        "svg": str(target),
        "bytes": len(svg),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())