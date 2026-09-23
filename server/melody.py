"""FluteBand AI — выделение мелодических полос страницы («только мелодия»).

Зачем это нужно. Движок homr приводит любую страницу к ширине 1920 px и сохраняет пропорции, поэтому
время распознавания зависит от **высоты** картинки: вся страница сборника (фортепиано + блокфлейта) —
это 17.9 с поиск станов и 24.3 с разбор строк, а одна система — 2.9 с и 4.6 с. Если оставить только
верхний стан каждой системы (мелодия блокфлейты) и склеить полосы в одну невысокую картинку, движок
работает примерно вчетверо быстрее и распознаёт **ту же мелодию** (проверено: 86 нот из 86 совпали
по высоте и порядку, `docs/omr-real.md`).

Геометрия ищется без нейросети, обычными средствами обработки изображений (OpenCV): линейки стана —
это длинные горизонтальные штрихи, они находятся морфологией, затем собираются в пятилинейники, а
пятилинейники — в системы. Это дёшево (десятки миллисекунд) и проверено против геометрии самого homr
на настоящих страницах: четыре системы по три стана найдены там же, где их видит движок.

Если полосы выделить не удалось (страница из одних мелодических станов, шумный снимок, слишком мало
станов), модуль честно сообщает об этом: вызывающий код распознаёт страницу целиком, как раньше.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

# Отступы вокруг стана мелодии: сверху больше (высокие ноты, лиги, динамика), снизу меньше —
# но так, чтобы не залезть в следующий стан (партию фортепиано).
PAD_ABOVE_STEPS = 3.2
PAD_BELOW_STEPS = 2.2
GAP_BEFORE_NEXT_STEPS = 1.6

# Пятилинейник: пять линий с примерно равным шагом
MAX_STEP_RATIO = 3.0
MIN_STEP_PX = 3
MAX_STEP_PX = 40

# Система: станы, между которыми промежуток меньше этого числа шагов
SYSTEM_GAP_STEPS = 12

# Промежуток между склеенными полосами — доля средней высоты полосы
STITCH_GAP_RATIO = 0.25
MIN_STITCH_GAP_PX = 8


def _line_rows(binary: np.ndarray) -> list[int]:
    """Строки-линейки: длинные горизонтальные штрихи. Возвращает середины линеек сверху вниз."""
    height, width = binary.shape[:2]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (10, 1))
    # Эрозия длинным ядром убирает ноты, штили и текст; растяжение возвращает толщину линеек
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_ERODE, kernel, iterations=2)
    horizontal = cv2.morphologyEx(horizontal, cv2.MORPH_DILATE, kernel, iterations=2)
    horizontal = cv2.morphologyEx(horizontal, cv2.MORPH_CLOSE, kernel, iterations=2)
    row_ink = (horizontal > 0).sum(axis=1)
    rows = np.where(row_ink >= width * 0.25)[0]
    if len(rows) == 0:
        return []

    lines: list[int] = []
    start = previous = int(rows[0])
    for row in rows[1:]:
        row = int(row)
        if row - previous > 2:  # толстая линейка (2–3 px) склеивается в одну
            lines.append((start + previous) // 2)
            start = row
        previous = row
    lines.append((start + previous) // 2)
    return lines


def detect_staves(image: np.ndarray) -> list[list[int]]:
    """Найти пятилинейные станы. Каждый стан — пять координат строк сверху вниз."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 21, 5
    )
    lines = _line_rows(binary)
    if len(lines) < 5:
        return []

    staves: list[list[int]] = []
    index = 0
    while index + 4 < len(lines):
        group = lines[index:index + 5]
        gaps = [group[i + 1] - group[i] for i in range(4)]
        if (
            min(gaps) >= MIN_STEP_PX
            and max(gaps) <= MAX_STEP_PX
            and max(gaps) <= MAX_STEP_RATIO * min(gaps)
        ):
            staves.append(group)
            index += 5
        else:
            index += 1
    return staves


def group_systems(staves: list[list[int]]) -> list[list[list[int]]]:
    """Собрать станы в системы: внутри системы промежуток небольшой, между системами — большой."""
    systems: list[list[list[int]]] = []
    for staff in staves:
        if systems:
            previous = systems[-1][-1]
            step = max(1.0, (previous[-1] - previous[0]) / 4)
            if staff[0] - previous[-1] <= SYSTEM_GAP_STEPS * step:
                systems[-1].append(staff)
                continue
        systems.append([staff])
    return systems


def melody_bands(image: np.ndarray) -> list[tuple[int, int]]:
    """Полосы мелодии: верхний стан каждой системы, с отступами и без захода в следующий стан."""
    height = image.shape[0]
    systems = group_systems(detect_staves(image))
    bands: list[tuple[int, int]] = []
    for system in systems:
        top = system[0]
        step = (top[-1] - top[0]) / 4
        from_y = int(max(0, top[0] - PAD_ABOVE_STEPS * step))
        to_y = int(min(height, top[-1] + PAD_BELOW_STEPS * step))
        if len(system) > 1:
            next_step = max(1.0, (system[1][-1] - system[1][0]) / 4)
            to_y = min(to_y, int(system[1][0] - GAP_BEFORE_NEXT_STEPS * next_step))
        if to_y - from_y >= 8:  # слишком узкая полоса — признак ошибки геометрии
            bands.append((from_y, to_y))
    return bands


def build_melody_strip(image_path: Path, out_path: Path) -> dict:
    """Склеить мелодические полосы страницы в одну картинку.

    Возвращает словарь с полем `ok`: если полосы выделить не удалось или страница и без того состоит
    из одних мелодических станов, `ok=False` и указана причина — вызывающий код распознаёт страницу
    целиком, как раньше.
    """
    image = cv2.imread(str(image_path))
    if image is None:
        return {"ok": False, "reason": "не удалось прочитать изображение"}

    height, width = image.shape[:2]
    staves = detect_staves(image)
    systems = group_systems(staves)
    if len(staves) < 2:
        return {
            "ok": False,
            "reason": "станы не найдены",
            "staves": len(staves),
            "width": width,
            "height": height,
        }

    # На странице из одних мелодических станов (сборник для флейты без фортепиано) выделять нечего
    if all(len(system) == 1 for system in systems):
        return {
            "ok": False,
            "reason": "на странице нет аккомпанирующих станов — вся страница и есть мелодия",
            "staves": len(staves),
            "systems": len(systems),
            "width": width,
            "height": height,
        }

    bands = melody_bands(image)
    if len(bands) < 2:
        return {
            "ok": False,
            "reason": "не удалось выделить мелодические полосы",
            "staves": len(staves),
            "systems": len(systems),
            "bands": len(bands),
            "width": width,
            "height": height,
        }

    heights = [to_y - from_y for from_y, to_y in bands]
    gap = max(MIN_STITCH_GAP_PX, int(float(np.median(heights)) * STITCH_GAP_RATIO))
    total_height = sum(heights) + gap * (len(bands) - 1)
    canvas = np.full((total_height, width, 3), 255, dtype=np.uint8)
    cursor = 0
    for (from_y, to_y), band_height in zip(bands, heights):
        canvas[cursor:cursor + band_height] = image[from_y:to_y]
        cursor += band_height + gap

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(out_path), canvas):
        return {"ok": False, "reason": "не удалось записать картинку с мелодией", "width": width, "height": height}

    kept_staves = len(bands)
    return {
        "ok": True,
        "stripPath": str(out_path),
        "systems": len(systems),
        "stavesOnPage": len(staves),
        "melodyStaves": kept_staves,
        "extraStaves": len(staves) - kept_staves,
        "sourceWidth": width,
        "sourceHeight": height,
        "stripWidth": width,
        "stripHeight": int(total_height),
        # Доли высоты страницы — чтобы в отчёте было видно, что именно попало в мелодию
        "bands": [
            {"from": round(from_y / height, 4), "to": round(to_y / height, 4)}
            for from_y, to_y in bands
        ],
    }