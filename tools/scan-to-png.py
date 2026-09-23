# FluteBand AI — перевод настоящего скана (JPEG) в PNG для замеров.
#
# Зачем отдельный шаг на Python: стенды замера работают в Node, а в проекте нет и не должно быть
# npm-зависимостей, поэтому JPEG (он есть почти во всех библиотечных сканах) раскодирует Pillow —
# он уже установлен вместе с сервисом распознавания. Дальше со страницей работает код приложения.
#
# Запуск: python tools/scan-to-png.py <вход.jpg> <выход.png> [максимальная сторона, по умолчанию 2000]
# Размер по умолчанию совпадает с тем, что приложение даёт снимку с телефона (prepareImageBlob maxSide 2000).

import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) < 3:
        print('нужно: python tools/scan-to-png.py <вход.jpg> <выход.png> [макс. сторона]')
        return 2
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
    if not source.exists():
        print(f'нет файла: {source}')
        return 1

    image = Image.open(source)
    original = image.size
    image = image.convert('RGB')
    if max(image.size) > max_side:
        scale = max_side / max(image.size)
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, 'PNG', optimize=True)
    print(f'{source.name}: {original[0]}x{original[1]} -> {image.width}x{image.height}, {target}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())