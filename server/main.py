"""FluteBand AI — OMR-сервис (FastAPI): изображение страницы -> MusicXML.

Контракт (совпадает с заглушкой server/standalone.py):
    GET  /health      -> {status, mode, engines, defaultEngine, limits, modes, cache}
    GET  /engines     -> {defaultEngine, engines: [{id, available, verified, license, note, reason}]}
    POST /recognize   -> multipart/form-data, поле image (+ необязательные engine и mode)
                      -> {musicxml, engine, mode, melody, confidence, warnings, elapsedMs}

Режим распознавания (поле `mode`):
    full    — вся страница: мелодия и фортепианные партии (гармония точнее, время больше);
    melody  — только верхний стан каждой системы: движок приводит картинку к ширине 1920 px, поэтому
              короткая склейка распознаётся в разы быстрее, мелодия получается та же, а гармония
              выводится из мелодии (см. server/melody.py).

Движки распознавания — в server/engines.py (все бесплатные и с открытым кодом).
Замер точности: docs/omr-benchmark.md (стенд: node tools/omr-bench.mjs).

Приватность: изображения обрабатываются во временном каталоге и удаляются сразу после распознавания;
в логи не попадают картинки. Кэш — по SHA-256 изображения.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVER_DIR))

from engines import available_engines, pick_default_engine, recognize_bytes  # noqa: E402

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", 12 * 1024 * 1024))
RECOGNIZE_TIMEOUT = int(os.environ.get("RECOGNIZE_TIMEOUT", 180))
CACHE_SIZE = int(os.environ.get("CACHE_SIZE", 32))
RECOGNIZE_MODES = ("full", "melody")

app = FastAPI(title="FluteBand AI OMR", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_cache: dict[str, dict[str, Any]] = {}


@app.get("/health")
def health() -> dict[str, Any]:
    engines = available_engines()
    return {
        "status": "ok",
        "mode": "fastapi",
        "engines": [key for key, value in engines.items() if value["available"]],
        "defaultEngine": pick_default_engine(),
        "limits": {"maxImageBytes": MAX_IMAGE_BYTES, "recognizeTimeoutSec": RECOGNIZE_TIMEOUT},
        "modes": list(RECOGNIZE_MODES),
        "cache": {"size": len(_cache), "capacity": CACHE_SIZE},
    }


@app.get("/engines")
def engines_endpoint() -> dict[str, Any]:
    return {"defaultEngine": pick_default_engine(), "engines": list(available_engines().values())}


@app.post("/recognize")
async def do_recognize(
    image: UploadFile = File(...),
    engine: str = Form("auto"),
    mode: str = Form("full"),
) -> JSONResponse:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail={"error": "пустой файл изображения"})
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail={"error": f"изображение больше {MAX_IMAGE_BYTES // (1024 * 1024)} МБ"})
    if data[:3] != b"\xff\xd8\xff" and data[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(status_code=400, detail={"error": "ожидается JPEG или PNG"})

    mode = (mode or "full").strip().lower()
    if mode not in RECOGNIZE_MODES:
        raise HTTPException(
            status_code=400,
            detail={"error": f"неизвестный режим «{mode}»", "available": list(RECOGNIZE_MODES)},
        )

    chosen = pick_default_engine() if engine in ("auto", "", "stub") and engine == "auto" else engine
    digest = hashlib.sha256(data).hexdigest()
    cache_key = f"{chosen}:{mode}:{digest}"
    cached = _cache.get(cache_key)
    if cached:
        return JSONResponse({**cached, "cached": True})

    started = time.monotonic()
    result = recognize_bytes(chosen, data, timeout=RECOGNIZE_TIMEOUT, mode=mode)
    if not result.get("ok"):
        # Нехватка времени — это не «плохая страница», а слабый процессор: отвечаем 504 и подсказкой,
        # чтобы приложение показало понятный текст вместо «Internal Server Error»
        timed_out = bool(result.get("timeoutSec"))
        raise HTTPException(
            status_code=504 if timed_out else 422,
            detail={
                "error": result.get("error") or "распознавание не удалось",
                "engine": result.get("engine"),
                "detail": result.get("detail"),
                "timeoutSec": result.get("timeoutSec"),
                "available": [key for key, value in available_engines().items() if value["available"]],
            },
        )

    payload = {
        "musicxml": result["musicxml"],
        "engine": result["engine"],
        "mode": result.get("mode", "full"),
        "melody": result.get("melody"),
        "confidence": None,
        "warnings": result.get("warnings", []),
        "elapsedMs": result.get("elapsedMs", int((time.monotonic() - started) * 1000)),
        "imageBytes": len(data),
    }
    if len(_cache) >= CACHE_SIZE:
        _cache.pop(next(iter(_cache)))
    _cache[cache_key] = payload
    return JSONResponse(payload)


if __name__ == "__main__":  # локальный запуск без uvicorn-обёртки
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))