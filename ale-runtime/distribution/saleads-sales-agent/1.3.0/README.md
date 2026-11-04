# saleads-sales-agent 1.3.0

Propósito (`SOUL.md`), skills y trabajos programados de **Ale**, el experto en
marketing de bolsillo de SaleADS (ola `saleads-agente-marketing-loop-v1`). Son
textos de instrucciones para el Hermes oficial; no contienen lógica de SaleADS.

## Contenido

- `SOUL.md`: Ale orquesta a cinco especialistas y es el único que habla con el
  dueño. Los datos del negocio salen solo del MCP; internet (`web_buscar`,
  `web_leer`) solo para investigar el mercado. Todo gasto pasa por
  `saleads_request_approval` y la aprobación del dueño en la web.
- `skills/` (primer nivel, siempre instaladas): las 18 de 1.2.0 más
  `saleads-loop-orchestration` (fases, reparto, Jev, tarjetas, escrituras del
  cerebro).
- `skills/functions/`: skills de los especialistas, siempre instaladas:
  `saleads-market-research`, `saleads-reading-diagnosis`,
  `saleads-optimization-scaling` (MLB-004).
- `skills/types/<business_type>/`: la estrategia de cada tipo de negocio
  (`physical_product`, `service`, `infoproduct`). El servicio instala solo los
  tipos que el dueño confirmó en sus negocios (la unión, si tiene varios); sin
  ningún tipo confirmado, ninguno (MLB-003).
- `jobs.json`: los 7 trabajos de 1.2.0 más `saleads:loop-tick` (cada 3 h: lee el
  tablero y responde `[SILENT]` o un solo mensaje).
- `validate.py`: valida skills (en cualquier nivel, nombres únicos) y trabajos
  con el parser y el scanner de Hermes.

## Destino en la VM

- `SOUL.md` → `/opt/data/SOUL.md`
- `skills/...` → `/opt/data/skills/...` con la misma ruta (Hermes encuentra las
  skills anidadas).
- `jobs.json` no se copia: el servicio crea por nombre los trabajos que falten.

## Trabajos de 1.2.0

Se conservan los 7 y sus skills: el servicio nunca edita ni borra trabajos
(`orqa-sync.ts`), así que una VM que ya los tenía los sigue corriendo, y borrar
una skill que un trabajo carga lo rompería. `saleads:proactive-digest` y
`saleads:loop-tick` conviven: el primero resume el día, el segundo mueve el
loop y casi siempre responde `[SILENT]`. Si la prueba de varios días (D48)
muestra ruido, se retira el resumen en una versión siguiente.

## Validación

```bash
python validate.py <checkout de hermes-agent 818c13be>
```

Necesita `ruamel.yaml`, `croniter`, `pyyaml` y `python-dotenv`.
