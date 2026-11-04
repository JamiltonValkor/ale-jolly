# saleads-sales-agent 1.2.0

Propósito (`SOUL.md`), skills y trabajos programados del asistente de ventas
SaleADS para la ola `saleads-orqa-cliente-mvp-v1` (ORQA del usuario). Son textos
de instrucciones para el Hermes oficial; no contienen lógica de SaleADS.

## Contenido

- `SOUL.md`
- `skills/`: las 5 skills de 1.1.0 más 13 nuevas:
  - cerebro: `saleads-business-brain`;
  - proactivas: `saleads-proactive-digest`, `saleads-account-health`,
    `saleads-creative-fatigue`, `saleads-seasonal-lookahead`,
    `saleads-monthly-review`;
  - análisis adaptadas de ORQA: `saleads-company-analysis`,
    `saleads-decision-support`, `saleads-paid-growth`,
    `saleads-report-analysis`, `saleads-silo-analysis`,
    `saleads-carousel-quality`;
  - comunidad: `saleads-collective-learning` (compartir lecciones y revisar el
    catálogo de habilidades).
- `jobs.json` (`saleads-jobs/1`): trabajos con agente que el servicio crea por
  `POST /api/jobs` de Hermes al quedar lista la VM (OSB-009). Nombres
  `saleads:<trabajo>`; corren en la zona horaria del dueño.
- `validate.py`: valida skills y trabajos con el parser y el scanner de Hermes.

## Destino en la VM

- `SOUL.md` → `/opt/data/SOUL.md`
- `skills/<nombre>/...` → `/opt/data/skills/<nombre>/...`
- `jobs.json` no se copia a la VM: el servicio crea los trabajos por la API.

## Cambios frente a 1.1.0

- Sin tope fijo de mensajes: el agente decide cuándo hablar mirando su razón de
  ruido (`brain_value_report`). En un trabajo programado responde exactamente
  `[SILENT]` o un solo mensaje completo.
- Cierra lo que abre con loops del cerebro.
- Lo que mueve dinero o cambia campañas queda como recomendación.
- Las skills nuevas llevan `version` y `metadata.hermes.{category,tags}`. No
  declaran `requires_tools`: Hermes oculta la skill si falta una tool, y un MCP
  caído un momento no debe esconderla.

## Validación

```bash
python validate.py <checkout de hermes-agent 818c13be>
```

Necesita `ruamel.yaml`, `croniter`, `pyyaml` y `python-dotenv`.
