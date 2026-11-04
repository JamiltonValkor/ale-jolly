# saleads-brain: cerebro del negocio en la VM del usuario (ORQA cliente, OSB-004).
# Se publica solo en el repositorio privado saleads-brain y se fija por digest.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN useradd --uid 10000 --create-home --shell /usr/sbin/nologin brain
WORKDIR /app
COPY pyproject.toml README.md ./
COPY saleads_brain ./saleads_brain
RUN pip install ".[runtime]" \
 && python -c "import graphiti_core.graphiti, mcp.server.fastmcp, saleads_brain.server; print('imports ok')"
USER 10000:10000
EXPOSE 8765
ENTRYPOINT ["saleads-brain"]
CMD ["serve"]
