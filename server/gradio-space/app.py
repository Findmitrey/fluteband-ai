"""FluteBand AI — сервис распознавания нот как Gradio-пространство Hugging Face.

Почему именно так. У Hugging Face Docker-пространства требуют платного плана (PRO), а бесплатным
осталось Gradio: до двух пространств на личный аккаунт, железо ZeroGPU. Наш сервис считает на
процессоре (ONNX-движок homr), видеокарта ему не нужна вообще, поэтому мы берём бесплатное
Gradio-пространство и **монтируем в него свой FastAPI**. Адреса `/recognize`, `/health` и `/engines`
остаются ровно теми же, что и у Docker-варианта (`server/Dockerfile`), — приложению менять нечего,
на экране «Сканировать» просто вписывается адрес вида `https://имя-пространства.hf.space`.

Порядок работы этого файла:
  1) модели движка (3 файла ONNX, 150 МБ) раскладываются из папки `models/` репозитория в пакет homr —
     тогда после «пробуждения» пространства ничего не скачивается заново (диск на бесплатном тарифе
     непостоянный). Если папки нет, движок скачает модели сам при первом запросе;
  2) модели сверяются с тем, что ждёт установленная версия движка (`check_models`): у homr 0.6.2 (его
     ставит pip на Python 3.10) это модели 331, у 0.7.0 — 396, и набор не той версии движок скачает сам;
  3) поднимается наш FastAPI из `service/main.py`;
  4) в него монтируется простая страница Gradio — её видно на вкладке «App», ею удобно проверить
     сервис руками: загрузить фото страницы и получить MusicXML;
  5) uvicorn слушает порт 7860, которого ждёт Hugging Face.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE / "service"
MODELS = HERE / "models"
EXAMPLES = HERE / "examples"

# Рабочий каталог движка и число потоков: на бесплатном тарифе два ядра, больше брать бессмысленно
os.environ.setdefault("FLUTEBAND_WORK_DIR", str(HERE / ".omr-work"))
os.environ.setdefault("OMP_NUM_THREADS", str(min(2, os.cpu_count() or 2)))
os.environ.setdefault("PORT", "7860")
os.environ.setdefault("RECOGNIZE_TIMEOUT", "240")
# Видеокарты у сервиса нет (движок считает на процессоре), и версия движка закреплена в requirements.txt:
# homr 0.6.2 на Python 3.10 сам выбирает процессорный набор fp32, потому что CUDA в контейнере нет.
# Раньше здесь стоял ключ FLUTEBAND_HOMR_GPU=no, но у 0.6.2 такого флага нет вовсе (он появился в 0.7.0),
# так что ключ был бы пустой надеждой: набор моделей задаёт соответствие «версия движка + файлы в models/»,
# а не переменная. Что файлы действительно те, которые ждёт движок, проверяет check_models() при старте.

sys.path.insert(0, str(SERVICE))


def model_dirs() -> tuple[Path, Path]:
    """Каталоги моделей внутри установленного пакета homr (он ищет их рядом с собой)."""
    import homr

    package = Path(homr.__file__).resolve().parent
    return package / "segmentation", package / "transformer"


def ensure_models() -> dict:
    """Разложить модели движка по местам, которые ждёт homr.

    В репозитории лежит процессорный набор fp32 — именно его требует homr при FLUTEBAND_HOMR_GPU=no
    (набор fp16 нужен только там, где движок видит видеокарту). Возвращает отчёт: откуда взялись
    модели и сколько файлов скопировано. Ошибки здесь не должны валить сервис — если копировать нечего,
    homr скачает модели сам при первом распознавании.
    """
    vendored = sorted(MODELS.glob("*.onnx")) if MODELS.is_dir() else []
    if not vendored:
        return {"ok": True, "source": "моделей в репозитории нет — движок скачает сам", "copied": 0}
    try:
        segmentation, transformer = model_dirs()
        segmentation.mkdir(parents=True, exist_ok=True)
        transformer.mkdir(parents=True, exist_ok=True)
    except Exception as error:  # noqa: BLE001 — сервис должен подняться в любом случае
        return {"ok": False, "source": f"не нашёл пакет homr: {error}", "copied": 0}

    copied = []
    for model in vendored:
        target_dir = transformer if model.name.startswith(("encoder_", "decoder_")) else segmentation
        target = target_dir / model.name
        if target.exists() and target.stat().st_size == model.stat().st_size:
            continue
        shutil.copy2(model, target)
        copied.append(model.name)
    return {"ok": True, "source": "из репозитория", "copied": len(copied), "files": copied}


MODELS_REPORT = ensure_models()


def expected_models() -> list[Path]:
    """Файлы моделей, которые ждёт установленная версия homr (пути внутри его пакета)."""
    paths: list[Path] = []
    try:
        from homr.segmentation import config as segmentation_config

        path = getattr(segmentation_config, "segnet_path_onnx", None)
        if isinstance(path, str):
            paths.append(Path(path))
    except Exception:  # noqa: BLE001 — у другой версии движка имена настроек могут отличаться
        pass
    try:
        from homr.transformer.configs import default_config

        filepaths = default_config.filepaths
        for name in ("encoder_path", "decoder_path"):
            path = getattr(filepaths, name, None)
            if isinstance(path, str):
                paths.append(Path(path))
    except Exception:  # noqa: BLE001
        pass
    return paths


def check_models() -> dict:
    """Сверить раскладку моделей с тем, что ждёт движок.

    Смысл проверки: если в репозитории окажется набор от другой версии homr (у 0.6.2 это модели 331,
    у 0.7.0 — 396), движок молча скачает свои модели во время первого запроса. Замерено на контейнере
    с Python 3.10: без этой сверки он скачивал три файла (одно это — 51 МБ) прямо в запросе ученика.
    Поэтому расхождение должно быть видно в журнале пространства, а не оставаться загадкой.
    """
    expected = expected_models()
    checked = [path for path in expected if path.suffix == ".onnx"]
    missing = [path.name for path in checked if not path.is_file()]
    return {"expected": len(checked), "missing": missing}


MODELS_CHECK = check_models()

# Наш сервис: те же маршруты, что и в Docker-варианте
from main import app as api  # noqa: E402  (импорт после sys.path и подготовки моделей)

import gradio as gr  # noqa: E402
from engines import recognize_bytes  # noqa: E402

UI_WORK = Path(os.environ["FLUTEBAND_WORK_DIR"]) / "ui"
UI_WORK.mkdir(parents=True, exist_ok=True)


def recognize_from_ui(image_path: str | None, mode: str) -> tuple[str, str | None, str]:
    """Ручная проверка сервиса со страницы Gradio: фото → MusicXML."""
    if not image_path:
        return "Сначала выберите фото страницы с нотами.", None, ""
    data = Path(image_path).read_bytes()
    result = recognize_bytes(
        "homr",
        data,
        timeout=int(os.environ.get("RECOGNIZE_TIMEOUT", "240")),
        mode=mode or "melody",
    )
    if not result.get("ok"):
        return f"Распознать не удалось: {result.get('error') or 'неизвестная ошибка'}", None, ""

    xml = result["musicxml"]
    # Имя файла уникальное: два хранения подряд не должны затирать друг другу результат, который
    # браузер ещё не скачал. Старые файлы подчищаем, чтобы рабочий каталог не рос без предела.
    out = UI_WORK / f"recognize-{int(time.time() * 1000)}.musicxml"
    out.write_text(xml, encoding="utf-8")
    for stale in sorted(UI_WORK.glob("recognize-*.musicxml"))[:-50]:
        stale.unlink(missing_ok=True)

    measures = xml.count("<measure")
    seconds = (result.get("elapsedMs") or 0) / 1000
    mode_label = "только мелодия" if result.get("mode") == "melody" else "вся страница"
    lines = [
        f"**Готово.** Движок: {result.get('engine')}, режим: {mode_label}, время: {seconds:.1f} с, тактов: {measures}.",
    ]
    melody = result.get("melody") or {}
    if melody.get("ok"):
        lines.append(
            f"Мелодию выделил сам сервис: станов на странице {melody.get('stavesOnPage')}, "
            f"в мелодию взято {melody.get('melodyStaves')}."
        )
    elif melody:
        lines.append(f"Мелодию выделить не удалось ({melody.get('reason')}) — распознана вся страница.")
    for warning in result.get("warnings") or []:
        lines.append(f"- {warning}")
    if MODELS_REPORT.get("copied"):
        lines.append(f"- модели движка взяты из репозитория ({MODELS_REPORT['copied']} файлов)")
    return "\n\n".join(lines), str(out), xml[:4000]


def _example_files() -> list[str]:
    if not EXAMPLES.is_dir():
        return []
    return [str(path) for path in sorted(EXAMPLES.glob("*.png"))[:2]]


demo = gr.Interface(
    fn=recognize_from_ui,
    inputs=[
        gr.Image(type="filepath", label="Фото страницы с нотами", sources=["upload", "webcam"]),
        gr.Radio(
            choices=[("Только мелодия (быстрее)", "melody"), ("Вся страница (мелодия и фортепиано)", "full")],
            value="melody",
            label="Режим распознавания",
        ),
    ],
    outputs=[
        gr.Markdown(label="Результат"),
        gr.File(label="MusicXML"),
        gr.Textbox(label="Начало MusicXML", lines=14),
    ],
    examples=[[path, "melody"] for path in _example_files()],
    title="FluteBand AI — распознавание нот",
    description=(
        "Сервис превращает фото страницы с нотами в **MusicXML**, из которого приложение FluteBand AI "
        "строит минус. Движок — [homr](https://github.com/liebharc/homr) (ONNX, процессор, бесплатно).\n\n"
        "Приложение обращается к этому же пространству по адресу `https://имя-пространства.hf.space` "
        "(маршрут `POST /recognize`). Первый запрос после «сна» дольше обычного: движок поднимает модели."
    ),
    flagging_mode="never",
)

# Монтируем страницу Gradio в наш FastAPI. Наши маршруты (/health, /engines, /recognize) объявлены
# раньше, поэтому в root они и остаются, а всё остальное отдаёт Gradio — так требование Hugging Face
# «SDK: Gradio» выполняется, и при этом REST-контракт сервиса не меняется.
app = gr.mount_gradio_app(api, demo, path="/")


def warmup() -> None:
    """Прочитать модели движка при старте, чтобы первый запрос не ждал их с диска.

    Полное пробное распознавание здесь делать **нельзя**. Очередь распознаваний одна (два ядра на
    бесплатном тарифе), поэтому прогрев задерживал бы первый запрос ученика на всё своё время, а
    быстрее следующий запрос от него не становится: модели поднимаются внутри первого распознавания.
    Измерено на контейнере с двумя ядрами: с прогревом первый запрос занял 53 с (25 с ожидания
    прогрева + 28 с распознавания), без него — те же 28 с распознавания сразу.
    """
    if os.environ.get("FLUTEBAND_WARMUP", "1") == "0" or not MODELS.is_dir():
        return
    megabytes = 0
    for model in sorted(MODELS.glob("*.onnx")):
        with model.open("rb") as handle:
            while handle.read(1 << 20):  # читаем по мегабайту: файлы большие, целый в память не берём
                pass
        megabytes += model.stat().st_size / 1024 / 1024
    print(f"FluteBand AI: модели движка прочитаны с диска ({megabytes:.0f} МБ)", flush=True)


if __name__ == "__main__":
    import uvicorn

    print(f"FluteBand AI: модели — {MODELS_REPORT.get('source')}, порт {os.environ['PORT']}", flush=True)
    if MODELS_CHECK["missing"]:
        print(
            "FluteBand AI: ВНИМАНИЕ — движок ждёт модели, которых нет: "
            + ", ".join(MODELS_CHECK["missing"])
            + ". Он скачает их сам при первом запросе (это медленно и ломается при двух запросах сразу). "
            "Проверьте, что models/ в репозитории соответствует версии homr из requirements.txt.",
            flush=True,
        )
    elif MODELS_CHECK["expected"]:
        print(f"FluteBand AI: движок ждёт {MODELS_CHECK['expected']} файла моделей — все на месте", flush=True)
    warmup()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]), log_level="info")