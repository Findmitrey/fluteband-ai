#!/usr/bin/env python3
"""FluteBand AI — распознавание страницы из командной строки.

Примеры:
    python server/tools/recognize.py page.png                     # движок по умолчанию
    python server/tools/recognize.py page.png --engine=homr
    python server/tools/recognize.py page.png --out=result.musicxml
    python server/tools/recognize.py --list                       # какие движки доступны
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

from engines import available_engines, pick_default_engine, run_engine  # noqa: E402


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a.split("=")[0]: a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}

    if "--list" in sys.argv:
        for engine, info in available_engines().items():
            state = "доступен" if info["available"] else f"нет ({info['reason']})"
            verified = "проверен" if info["verified"] else "не проверен"
            print(f"{engine:10} {state:45} {verified:12} {info['license']}")
        print(f"\nдвижок по умолчанию: {pick_default_engine()}")
        return 0

    if not args:
        print(__doc__)
        return 2

    image = Path(args[0])
    if not image.exists():
        print(f"Файл не найден: {image}")
        return 2

    engine = flags.get("--engine") or pick_default_engine()
    timeout = int(flags.get("--timeout", "300"))
    work_dir = SERVER_DIR.parent / ".omr-work" / f"cli-{image.stem}"
    result = run_engine(engine, image, work_dir, timeout=timeout)

    if not result["ok"]:
        print(json.dumps({k: v for k, v in result.items() if k != "musicxml"}, ensure_ascii=False, indent=2))
        return 1

    out = Path(flags["--out"]) if "--out" in flags else work_dir / f"{image.stem}.musicxml"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(result["musicxml"], encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "engine": result["engine"],
        "elapsedMs": result["elapsedMs"],
        "musicxml": str(out),
        "bytes": len(result["musicxml"]),
        "warnings": result.get("warnings", []),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())