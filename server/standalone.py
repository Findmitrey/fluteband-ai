#!/usr/bin/env python3
"""FluteBand AI — OMR-сервис в режиме заглушки.

Работает только на стандартной библиотеке Python (никаких установок) и повторяет контракт
боевого сервиса (server/main.py), отдавая эталонный MusicXML. Нужен, чтобы проверить весь
тракт «страница -> MusicXML -> внутренняя модель -> минус» ещё до подключения настоящего OMR.

Запуск:
    python server/standalone.py            # порт 8000
    PORT=8080 python server/standalone.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
DEFAULT_FIXTURE = FIXTURES / "ode-to-joy.musicxml"

# Windows-консоль по умолчанию cp1252 — принудительно включаем UTF-8, иначе русский текст падает
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

MAX_IMAGE_BYTES = 12 * 1024 * 1024  # ограничение бесплатного тарифа: не принимаем гигантские файлы
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def load_fixture(name: str | None = None) -> str:
    path = DEFAULT_FIXTURE if not name else FIXTURES / name
    if not path.exists():
        path = DEFAULT_FIXTURE
    return path.read_text(encoding="utf-8")


def detect_engine(body: bytes) -> str:
    match = re.search(rb'name="engine"\r\n\r\n([^\r\n]+)', body)
    if match:
        return match.group(1).decode("utf-8", "replace").strip()
    return "stub"


def image_looks_valid(body: bytes) -> tuple[bool, str]:
    if len(body) < 512:
        return False, "тело запроса слишком короткое — изображение не передано"
    if len(body) > MAX_IMAGE_BYTES:
        return False, f"изображение больше {MAX_IMAGE_BYTES // (1024 * 1024)} МБ"
    if JPEG_MAGIC in body[:4096] or PNG_MAGIC in body[:4096]:
        return True, ""
    return False, "не найдена подпись JPEG/PNG — похоже, файл не отправлен"


class Handler(BaseHTTPRequestHandler):
    server_version = "FluteBandOMR-stub/0.1"

    def _send(self, code: int, payload: dict | str, content_type: str = "application/json; charset=utf-8") -> None:
        data = payload.encode("utf-8") if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802 (имя требуется стандартной библиотекой)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(200, {
                "status": "ok",
                "mode": "stub",
                "engines": ["stub"],
                "notes": "Заглушка отдаёт эталонный MusicXML. Боевой OMR — server/main.py",
                "limits": {"maxImageBytes": MAX_IMAGE_BYTES},
            })
        elif path == "/engines":
            self._send(200, {
                "engines": [
                    {"id": "stub", "available": True, "license": "—", "note": "эталонный MusicXML для проверки тракта"},
                ]
            })
        else:
            self._send(404, {"error": "не найдено", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path != "/recognize":
            self._send(404, {"error": "не найдено", "path": path})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send(400, {"error": "пустой запрос", "hint": "Отправьте изображение как multipart/form-data, поле image"})
            return
        body = self.rfile.read(length)
        ok, reason = image_looks_valid(body)
        engine = detect_engine(body)
        if not ok:
            self._send(400, {"error": reason, "engine": engine})
            return
        if engine not in ("stub", "auto", ""):
            self._send(422, {
                "error": f"движок «{engine}» в режиме заглушки недоступен",
                "hint": "Запустите боевой сервис: uvicorn main:app --app-dir server",
                "available": ["stub"],
            })
            return
        warnings = ["Это эталонная страница-заглушка, а не результат распознавания вашего фото"]
        self._send(200, {
            "musicxml": load_fixture(),
            "engine": "stub",
            "confidence": 1.0,
            "warnings": warnings,
            "imageBytes": len(body),
        })

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("[omr-stub] " + (fmt % args) + "\n")


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"FluteBand OMR (заглушка) слушает http://127.0.0.1:{port}")
    print("  GET  /health      — состояние сервиса")
    print("  GET  /engines     — доступные движки распознавания")
    print("  POST /recognize   — изображение (multipart, поле image) -> MusicXML")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено")


if __name__ == "__main__":
    main()