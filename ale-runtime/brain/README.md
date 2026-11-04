# saleads-brain

Cerebro del negocio de SaleADS. Corre en la VM de cada usuario, al lado de
Hermes, y guarda el grafo de cada negocio del dueño. Almacena y recupera
conocimiento; no tiene un modelo propio y su ruta de IA está desactivada.
Consulta el [README del runtime](../README.md) para las dependencias y el
despliegue del conjunto.

## Piezas

| Módulo | Qué hace |
|---|---|
| `saleads_brain/ontology/base.yaml` | Fuente única de la ontología base /2 (38 tipos y 41 relaciones; conserva lectura /1). |
| `saleads_brain/ontology` | Genera los modelos pydantic (Graphiti), listas por evento y tipos aprendidos colgados de un padre. |
| `saleads_brain/provenance.py` | Lista cerrada de procedencias y precedencia: el dueño manda en lo declarado, la plataforma en lo medido, lo inferido nunca reemplaza lo validado. |
| `saleads_brain/governance.py` | Propuestas con dos fuentes; autoactivación solo semántica; vocabulario sensible bilingüe por palabra completa. |
| `saleads_brain/ledger.py` | Ledger SQLite: eventos, outbox, propuestas, conocimiento bitemporal y auditoría. |
| `saleads_brain/states.py` | 8 estados internos → 4 visibles (observado, propuesto, validado, reemplazado). |
| `saleads_brain/knowledge.py`, `curation.py`, `recall.py` | Memoria gestionada con fuentes auténticas, experiencia por rol, lotes y proyección recuperable; sin modelo. |
| `saleads_brain/baseline.py` | Recupera la semilla estructurada autenticada con hash y procedencia API, sin promover notas históricas no verificadas. |

Los contratos y el API privado de la variante gestionada se documentan en
[managed-memory.md](docs/managed-memory.md). La activación es explícita y no cambia
el comportamiento del asistente clásico.

## Cobertura de la ontología frente al plan de negocio

| Dominio del plan | Tipos |
|---|---|
| Identidad | Business, Location, Person |
| Oferta | ProductOrService, Offer, Proof |
| Mercado y clientes | Segment, CustomerNeed, Customer, Lead, Deal, Feedback |
| Competencia | Competitor |
| Canales y campañas | Channel, Campaign, Creative, MarketMoment |
| Estrategia e hipótesis | Goal, Hypothesis, MetricObservation |
| Operación y proveedores | Supplier, OperationalConstraint |
| Aprendizajes y decisiones | Decision, Learning |
| Meta | Evidence |

Cobertura: 100 % de los dominios del plan. Ningún tipo modela datos personales de clientes finales (test `test_no_type_models_personal_data`).

## Desarrollo

```bash
uv venv --python 3.12 .venv && uv pip install -e '.[dev]' --python .venv/bin/python
.venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/mypy
```
