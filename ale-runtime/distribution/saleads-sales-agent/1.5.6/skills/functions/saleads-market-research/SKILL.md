---
name: saleads-market-research
description: "Investigación de mercado del investigador: referentes (marcas de EE. UU.), competidores locales, ganadores, ganchos, saturación de ángulos, avatares y validación en el país donde se pauta. Separa dato de inferencia, cita la fuente y la fecha de todo, y deja candidatos en el cerebro para que el estratega apueste. Úsala en cada tarjeta de investigación, con TrendTrack si su MCP está conectado o con web_buscar y web_leer si no."
version: 1.5.6
metadata:
  hermes:
    category: saleads-research
    tags: [saleads, research, market, competitors]
  saleads:
    origin: juan
    confidence: medium
    adapted_from: investigacion-trendtrack
---

# Investigación de mercado

Adaptada de la skill de investigación competitiva de Juan Guilibreros (6 etapas). Aquí no hay chat con el dueño: trabajas una tarjeta, dejas el resultado en la tarjeta y en el cerebro, y Ale decide qué contarle.

## Reglas que no se negocian

1. **Una tarjeta = un alcance acotado.** Haz solo la etapa o la pregunta que pide la tarjeta, completa. Si para responder necesitas otra etapa, termina la tuya y deja en el resultado qué falta y por qué. Apunta a terminar en 10 minutos o menos: pocas búsquedas buenas valen más que muchas.
2. **Dato frente a inferencia.** Marca cada punto como **Dato** (sale de una fuente que puedes citar) o **Inferencia** (tu lectura). Sin fuente no hay dato.
3. **Fuente y fecha en todo.** Cada anuncio, marca, precio o cifra lleva su URL, la fecha en que lo viste y, si la tiene, la fecha de la fuente. Si una búsqueda falla o no trae nada, dilo: un error explícito es mejor que un hueco silencioso.
4. **Inglés con traducción.** Todo texto en inglés de un anuncio o una landing va con su traducción al lado.
5. **Sin filtro por encaje.** No descartes un hallazgo porque no calza con el negocio; el juicio de encaje va aparte, marcado como inferencia.
6. **Crítico, no complaciente.** Señala datos débiles, contradicciones y riesgos. Corrige tus errores de tarjetas anteriores apenas los ves.
7. **Nada inventado.** Internet sirve para investigar el mercado, nunca para inventar datos del negocio del dueño. Los datos del negocio salen solo del MCP de SaleADS.

## Herramientas

- **TrendTrack**, solo si su MCP está conectado a este perfil. Lee `references/trendtrack.md` antes de la primera búsqueda. Gasta créditos: **no gastes sin permiso**. Si la tarjeta no trae el permiso del dueño, deja en el resultado cuántos créditos estimas y para qué, y termina; Ale lo pide.
- **Sin TrendTrack:** `web_buscar` (RSS de Google News y Bing) y `web_leer` (lectura de una URL). Busca en el idioma de la gente que compra y combina los términos del problema, la solución, el mecanismo y los ganchos. Las landings de Shopify a veces no abren: reporta el título y la URL y aclara que no viste el contenido.
- **El cerebro:** antes de buscar, consulta (`brain_query`) qué ya se investigó para este negocio. No repitas búsquedas que ya están ahí con fecha reciente.

## Las etapas

El detalle mínimo de cada etapa está en `references/etapas.md`. Resumen:

1. **Panorama:** marca o mercado, competidores directos (el mismo producto) y alternativas (otra solución al mismo problema), oferta y precios, embudo y landings.
2. **Ganadores:** solo evidencia de escala (más días al aire, más variantes, relanzamientos, versión estática y en video).
3. **Ganchos:** de la marca y de los competidores, con su etapa de conciencia, gatillo y avatar.
4. **Saturación de ángulos:** qué está sobreusado, qué está fresco, qué avatares no atiende nadie.
5. **Avatares:** 6 a 9, cada uno con su voz, su dolor, su deseo, su evidencia y su momento (creciendo, estable, emergente).
6. **Validación en el país donde se pauta:** qué ya existe, qué no, y si el competidor se queda (prueba, sostenido, consolidado).

Referentes de cómo pautar: marcas de EE. UU. (van adelante). Competidores: los del mercado local. La conclusión siempre se aterriza a la geografía donde se pauta.

## Qué entregas

En el resultado de la tarjeta, en texto claro (sin bloques visuales ni archivos):

1. Una o dos líneas de contexto y cualquier advertencia que cambie la lectura.
2. Los hallazgos de la etapa, cada uno marcado Dato o Inferencia, con fuente y fecha.
3. **Candidatos** para el estratega: avatares, ángulos, formatos u ofertas que vale la pena apostar, cada uno con su evidencia y su riesgo. Van en el resultado de la tarjeta, no como apuestas: apostar es del estratega y lo que vale para el negocio lo registra Ale.
4. Limitaciones de los datos y riesgos de promesa o de política (ver abajo).
5. Qué etapa o pregunta conviene después, si aplica. No pides permiso para continuar: Ale decide.

## Riesgos que siempre señalas

Promesas de salud (curar, eliminar, bajar X kilos), promesas cosméticas absolutas, expertos con nombres no verificables, segmentación por atributos personales sensibles y productos para niños. Preséntalos como dato del mercado y sugiere la versión defendible («reduce la apariencia de…»), nunca como plantilla para copiar.

## Limitaciones que declaras cuando aplican

- La búsqueda por texto lee el copy, no lo que se dice en el video: un ángulo puede estar en muchos videos y aparecer en pocos textos.
- Fuera de la UE no hay alcance ni gasto confiables de los anuncios.
- Un anuncio con muchos días al aire pero alcance mínimo no es ganador.
- Si la marca es nueva, «el anuncio más longevo» tiene techo.

## Al terminar una tarjeta

Guarda en tu memoria los hallazgos clave con su fuente y su fecha, y qué búsquedas ya hiciste, para no repetirlas en la próxima tarjeta.
