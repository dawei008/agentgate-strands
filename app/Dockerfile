# AgentCore Runtime requires linux/arm64 images.
FROM --platform=linux/arm64 python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# AgentCore Runtime injects OTLP endpoints/credentials when observability is
# enabled; these only select the ADOT distro and eval-results destination.
ENV OTEL_PYTHON_DISTRO=aws_distro \
    OTEL_PYTHON_CONFIGURATOR=aws_configurator \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
    OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true \
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
    OTEL_PYTHON_DISABLED_INSTRUMENTATIONS="http,sqlalchemy,psycopg2,pymysql,sqlite3,aiopg,asyncpg,mysql_connector,urllib3,requests,system_metrics,google-genai" \
    EVALUATION_RESULTS_LOG_GROUP=eval-anything-results \
    PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["opentelemetry-instrument", "python", "main.py"]
