# FluteBand AI — отбор настоящих сканов для замера: где на странице вообще есть ноты.
#
# Зачем: в библиотечных книгах нотные страницы перемешаны с текстовыми, и качать всё подряд незачем.
# Признак нотной страницы — длинные горизонтальные тёмные линии (нотные линейки) во всю ширину:
# у нотной страницы таких строк десятки, у текстовой — единицы. Метрика грубая (на плотном тексте
# тоже бывают длинные строки), поэтому она только помогает выбрать страницы, а не заменяет глаза.
#
# Запуск: python tools/scan-quality.py страница1.jpg [страница2.jpg ...]
# Нужен Pillow (стоит вместе с сервисом распознавания). В приложении этот файл не участвует.

import sys
from pathlib import Path

from PIL import Image


def staff_rows(path, width=1400, dark=140, cover=0.5):
    image = Image.open(path).convert('L')
    if image.width > width:
        image = image.resize((width, round(image.height * width / image.width)), Image.BILINEAR)
    px = image.load()
    rows = 0
    total = 0
    lengths = []
    for y in range(image.height):
        run = 0
        best = 0
        dark_count = 0
        for x in range(image.width):
            if px[x, y] < dark:
                run += 1
                dark_count += 1
                best = max(best, run)
            else:
                run = 0
        lengths.append(best)
        total += dark_count
        if best >= image.width * cover:
            rows += 1
    return {
        'path': Path(path).name,
        'size': f'{image.width}x{image.height}',
        'staff_rows': rows,
        'ink_share': round(total / (image.width * image.height), 4),
        'longest': max(lengths) if lengths else 0,
    }


for arg in sys.argv[1:]:
    stats = staff_rows(arg)
    print(f"{stats['path']:28} {stats['size']:>10}  линеек-строк: {stats['staff_rows']:>4}  "
          f"чернил: {stats['ink_share']:.3f}  самая длинная полоса: {stats['longest']}")