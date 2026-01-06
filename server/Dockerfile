FROM python:3.12-alpine AS build

WORKDIR /app

COPY requirements.txt ./

RUN python3 -m venv /venv
RUN /venv/bin/pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY --from=build /venv /venv
ENV PATH="/venv/bin:$PATH"

COPY main.py ./

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
