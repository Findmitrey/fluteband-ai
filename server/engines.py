"""FluteBand AI — движки распознавания нот (все бесплатные и с открытым кодом).

Единая точка для сервиса (`server/main.py`) и для командной строки (`server/tools/recognize.py`).

Движки:
    stub      — эталонный MusicXML, проверка тракта без установки OMR
    homr      — ONNX-модели, основной движок проекта (быстро, устойчиво к простым учебным пьесам)
    oemer     — MIT, требует совместимый onnxruntime (см. ниже)
    audiveris — AGPL, требует Java

Установка движков без venv (все пакеты кладутся в server/deps):
    pip install --target server/deps homr verovio
    pip install --target server/deps oemer

Про oemer и onnxruntime: модели oemer содержат ConvTranspose с отрицательными pads, а onnxruntime
новых версий (>= 1.20) считает это ошибкой формы и падает с
«Attribute pads must not contain negative values». Поэтому oemer доступен, но помечен как
непроверенный; рабочий движок по умолчанию — homr.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
DEPS = SERVER_DIR / "deps"
FIXTURES = SERVER_DIR / "fixtures"
DEFAULT_FIXTURE = FIXTURES / "ode-to-joy.musicxml"

# Каталог для временных файлов движков: держим внутри проекта, чтобы не зависеть от прав на %TEMP%
WORK_ROOT = Path(os.environ.get("FLUTEBAND_WORK_DIR", SERVER_DIR.parent / ".omr-work"))

ENGINE_INFO = {
    "stub": {"license": "—", "note": "эталонный MusicXML для проверки тракта", "verified": True},
    "homr": {"license": "свободная (см. репозиторий homr)", "note": "ONNX-распознавание, основной движок", "verified": True},
    "oemer": {"license": "MIT", "note": "требует совместимый onnxruntime (отрицательные pads в ConvTranspose)", "verified": False},
    "audiveris": {"license": "AGPL", "note": "требует Java", "verified": False},
}


def ensure_deps_on_path() -> None:
    if DEPS.exists() and str(DEPS) not in sys.path:
        sys.path.insert(0, str(DEPS))


def engine_env(work_dir: Path | None = None) -> dict[str, str]:
    """Окружение для дочерних процессов движков: пути к пакетам и записываемые каталоги кэшей."""
    work_dir = work_dir or WORK_ROOT
    cache = work_dir / "cache"
    for folder in (work_dir, cache, cache / "matplotlib", cache / "tmp"):
        folder.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(DEPS) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["MPLCONFIGDIR"] = str(cache / "matplotlib")
    env["TEMP"] = str(cache / "tmp")
    env["TMP"] = str(cache / "tmp")
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["HF_HOME"] = str(cache / "huggingface")
    env["OMP_NUM_THREADS"] = env.get("OMP_NUM_THREADS", "4")
    return env


def _module_installed(name: str) -> bool:
    """Установлен ли движок.

    Два законных способа установки: локально пакеты кладутся в `server/deps`
    (`pip install --target server/deps homr`), а в контейнере на бесплатном облачном тарифе — обычным
    `pip install homr` в окружение Python. Раньше проверялся только первый, и в контейнере движок
    считался отсутствующим, хотя был установлен и работал.
    """
    if (DEPS / name).exists():
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def available_engines() -> dict[str, dict]:
    result: dict[str, dict] = {}
    for engine, info in ENGINE_INFO.items():
        if engine == "stub":
            available, reason = True, ""
        elif engine == "homr":
            available = _module_installed("homr")
            reason = "" if available else "не установлен: pip install --target server/deps homr"
        elif engine == "oemer":
            available = _module_installed("oemer")
            reason = "" if available else "не установлен: pip install --target server/deps oemer"
        else:  # audiveris — только внешний CLI
            found = shutil.which("audiveris")
            available = bool(found)
            reason = "" if available else "не найден в PATH (нужна Java)"
        result[engine] = {**info, "id": engine, "available": available, "reason": reason}
    return result


def pick_default_engine() -> str:
    engines = available_engines()
    for candidate in ("homr", "oemer", "audiveris"):
        if engines[candidate]["available"] and engines[candidate]["verified"]:
            return candidate
    return "stub"


def _find_musicxml(directory: Path, preferred: Path | None = None) -> Path | None:
    if preferred and preferred.exists():
        return preferred
    candidates = sorted(directory.rglob("*.musicxml"))
    if not candidates:
        candidates = sorted(directory.rglob("*.xml"))
    return candidates[0] if candidates else None


def _run(command: list[str], work_dir: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(work_dir),
        env=engine_env(work_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def run_engine(engine: str, image_path: Path, work_dir: Path, timeout: int = 180, mode: str = "full") -> dict:
    """Распознать изображение и вернуть {'ok', 'musicxml', 'engine', 'warnings', 'error', 'elapsedMs'}.

    Режим `mode`:
        full    — вся страница (мелодия + аккомпанемент), как раньше;
        melody  — только верхний стан каждой системы: движок работает примерно вчетверо быстрее и
                  распознаёт ту же мелодию, но гармония выводится из мелодии (партии фортепиано нет).
    """
    work_dir = Path(work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    # Дочерние процессы запускаются с cwd=work_dir, поэтому путь к картинке обязан быть абсолютным
    image_path = Path(image_path).resolve()
    started = time.monotonic()
    mode = (mode or "full").strip().lower()
    if mode not in ("full", "melody"):
        return {"ok": False, "engine": engine, "error": f"неизвестный режим «{mode}»", "available": ["full", "melody"]}

    if engine in ("stub", "", "auto"):
        engine = "stub" if engine != "auto" else pick_default_engine()
        if engine == "stub":
            return {
                "ok": True,
                "engine": "stub",
                "mode": "full",
                "musicxml": DEFAULT_FIXTURE.read_text(encoding="utf-8"),
                "warnings": ["Эталонная страница: это не результат распознавания вашего фото"],
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }

    engines = available_engines()
    if engine not in engines:
        return {"ok": False, "engine": engine, "error": f"неизвестный движок «{engine}»", "available": list(engines)}
    if not engines[engine]["available"]:
        return {
            "ok": False,
            "engine": engine,
            "error": f"движок «{engine}» недоступен: {engines[engine]['reason']}",
            "available": [key for key, value in engines.items() if value["available"]],
        }

    melody_meta: dict | None = None
    try:
        if engine == "oemer":
            command = [sys.executable, "-m", "oemer.ete", str(image_path), "-o", str(work_dir / "out")]
            result = _run(command, work_dir, timeout)
            found = _find_musicxml(work_dir / "out")
        elif engine == "homr":
            target = image_path
            if mode == "melody":
                # Оставляем только верхний стан каждой системы: движок приводит картинку к ширине
                # 1920 px, поэтому короткая склейка распознаётся в разы быстрее (см. server/melody.py)
                from melody import build_melody_strip

                melody_meta = build_melody_strip(image_path, work_dir / "melody.png")
                if melody_meta.get("ok"):
                    target = Path(melody_meta["stripPath"])
                else:
                    melody_meta = {**melody_meta, "fallback": True}
            command = [sys.executable, "-c", "from homr.main import main; main()", str(target)]
            result = _run(command, work_dir, timeout)
            found = _find_musicxml(work_dir, target.with_suffix(".musicxml"))
        else:  # audiveris
            command = ["audiveris", "-batch", "-export", "-output", str(work_dir / "out"), str(image_path)]
            result = _run(command, work_dir, timeout)
            found = _find_musicxml(work_dir / "out")
    except subprocess.TimeoutExpired:
        # Раньше это исключение уходило наружу и сервис отвечал «Internal Server Error» без объяснений.
        # На бесплатном облачном тарифе ядер меньше, чем на домашнем компьютере, и плотная страница
        # вполне может не уложиться в отведённое время — ученик должен увидеть понятный текст.
        return {
            "ok": False,
            "engine": engine,
            "error": f"движок «{engine}» не успел за {timeout} с",
            "detail": "Плотная страница на слабом процессоре распознаётся дольше. Снимите страницу по половине "
                      "или воспользуйтесь быстрым режимом; на бесплатном облачном тарифе ядер меньше, чем на компьютере.",
            "timeoutSec": timeout,
            "elapsedMs": int((time.monotonic() - started) * 1000),
        }

    elapsed = int((time.monotonic() - started) * 1000)
    if found is None:
        tail = ((result.stderr or "") + (result.stdout or "")).strip().splitlines()[-6:]
        return {
            "ok": False,
            "engine": engine,
            "error": f"движок «{engine}» не создал MusicXML",
            "detail": " | ".join(line.strip() for line in tail),
            "elapsedMs": elapsed,
        }

    warnings: list[str] = []
    if engine == "homr":
        warnings.append("homr не сообщает уверенность — проверьте ноты на экране перед игрой")
    elif engine == "oemer":
        warnings.append("oemer помечен как непроверенный: возможна несовместимость с onnxruntime")

    used_mode = "full"
    melody_out: dict | None = None
    if mode == "melody":
        if engine != "homr":
            warnings.append(f"режим «только мелодия» поддерживает движок homr, а не «{engine}»: распознана вся страница")
        elif melody_meta and melody_meta.get("ok"):
            used_mode = "melody"
            melody_out = melody_meta
            warnings.append(
                "Распознана только мелодия (верхняя строка): быстрее, но гармония выведена из мелодии — "
                "партии фортепиано в разборе нет"
            )
        else:
            melody_out = melody_meta
            reason = (melody_meta or {}).get("reason") or "не удалось выделить мелодию"
            warnings.append(f"Мелодию выделить не удалось ({reason}) — распознана вся страница")

    return {
        "ok": True,
        "engine": engine,
        "mode": used_mode,
        "melody": melody_out,
        "musicxml": found.read_text(encoding="utf-8", errors="replace"),
        "warnings": warnings,
        "elapsedMs": elapsed,
        "log": ((result.stderr or "") + (result.stdout or "")).strip().splitlines()[-3:],
    }


def recognize_bytes(engine: str, image_bytes: bytes, timeout: int = 180, mode: str = "full") -> dict:
    """Распознать изображение из памяти (для сервиса). Работает во временном каталоге."""
    work_dir = WORK_ROOT / f"job-{int(time.time() * 1000)}"
    work_dir.mkdir(parents=True, exist_ok=True)
    image_path = work_dir / "page.png"
    if image_bytes[:3] == b"\xff\xd8\xff":
        image_path = work_dir / "page.jpg"
    image_path.write_bytes(image_bytes)
    try:
        return run_engine(engine, image_path, work_dir, timeout=timeout, mode=mode)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)