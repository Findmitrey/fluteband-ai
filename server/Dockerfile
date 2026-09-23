# FluteBand AI — образ OMR-сервиса (бесплатный тариф: Hugging Face Spaces и другие)
#
# Порт берётся из переменной PORT (Spaces ожидает 7860).
# Движок распознавания ставится по умолчанию: без него сервис умеет только заглушку.
# Сборка без движка (быстрая, для проверки контракта):  docker build --build-arg INSTALL_HOMR=0 .

FROM python:3.11-slim

ARG INSTALL_HOMR=1

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=7860 \
    MAX_IMAGE_BYTES=12582912 \
    RECOGNIZE_TIMEOUT=240 \
    OMP_NUM_THREADS=2 \
    FLUTEBAND_WORK_DIR=/tmp/omr-work \
    HF_HOME=/tmp/hf-cache

WORKDIR /app

# Системные библиотеки для OpenCV: движок homr читает страницу через cv2, а в slim-образе нет
# libxcb/libgl — без них распознавание падало с «ImportError: libxcb.so.1» (проверено на контейнере).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Слой зависимостей сервиса отдельно от кода: пересборка после правок кода не тянет pip заново
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Настоящий движок распознавания (MIT, CPU, ONNX)
RUN if [ "$INSTALL_HOMR" = "1" ]; then pip install --no-cache-dir homr; fi

# Модели движка скачиваем на этапе сборки (у homr для этого есть режим --init). Тогда первый запрос
# ученика не ждёт загрузки моделей, а сам сервис на бесплатном тарифе просыпается быстрее.
RUN if [ "$INSTALL_HOMR" = "1" ]; then python -c "from homr.main import main; main()" --init; fi

COPY . .

# Бесплатные облачные тарифы запускают контейнер не от root: создаём пользователя и отдаём ему рабочий
# каталог, кэш моделей и сам пакет движка (homr пишет кэш рядом с моделями).
RUN useradd -m -u 1000 user \
    && mkdir -p /tmp/omr-work /tmp/hf-cache \
    && chown -R user:user /app /tmp/omr-work /tmp/hf-cache /usr/local/lib/python3.11/site-packages/homr

USER user

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','7860')+'/health',timeout=4)"

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]