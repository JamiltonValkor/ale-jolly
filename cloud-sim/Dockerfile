FROM python:3.12.7-alpine3.20
WORKDIR /app
COPY cloudsim ./cloudsim
ENV PYTHONUNBUFFERED=1
EXPOSE 8070
HEALTHCHECK --interval=5s --timeout=3s CMD wget -qO- http://127.0.0.1:8070/healthz >/dev/null || exit 1
CMD ["python", "-m", "cloudsim"]
