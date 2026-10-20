FROM python:3.12-slim
WORKDIR /app
COPY server.py email_template.html ./
ENV PYTHONUNBUFFERED=1 DB_PATH=/app/data/registrations.db PORT=8080
EXPOSE 8080
CMD ["python3", "server.py"]
