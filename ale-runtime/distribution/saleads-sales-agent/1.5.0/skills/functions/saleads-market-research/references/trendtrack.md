# TrendTrack: herramientas, costos y trampas

Las herramientas de TrendTrack son diferidas: solo existen si su MCP está conectado a este perfil. Todo lo que gasta créditos necesita el permiso del dueño en la tarjeta.

## Herramientas útiles y para qué

| Herramienta | Uso | Costo aprox. |
|---|---|---|
| `brief_competitor` (competitor = shop ID) | Ficha de la tienda, catálogo, emails, creativos top | ~12 créditos |
| `list_tracked_brands` | Ver si la marca ya está en el brandtracker y obtener su ID | ~6 |
| `add_to_brandtracker` (shop_id) | Agregar la marca. **Pedir permiso antes** | ~1 |
| `get_brandtracker_transcripts` | Guiones completos de video con uso, impresiones y fechas. La fuente más rica | ~1 por guion |
| `search_ads` | Anuncios por dominio, copy o página | ~30 por 20 resultados; ~2 con limit 1 |
| `scan_ad` (collation_id) | Gancho de los 3 primeros segundos, copy, landing, trayectoria y miembros del creativo | ~3 |
| `find_similar_shops` | Tiendas parecidas con ingresos y tráfico | ~40 |

## Recetas

**Transcripciones del brandtracker** (después de tener el ID):
- `sort_by=usageCount`, `time_period=last1y`, limit 40–50: los guiones más duplicados.
- `sort_by=totalImpressions`: los que más impresiones juntaron (los mejores candidatos a ganadores).
- `sort_by=longestRunning`: los más longevos.
- `time_period=last30d`: hacia dónde va la marca hoy.

**Anuncios de la marca:** `search_ads` con `query=<dominio>`, `search_in=domain`, `status=all`, y por separado `sort_by` = `reach`, `longestRunning` o `mostDuplicates`. Agrega `media_type=image` para medir estáticos (el total de resultados da la proporción).

**Mercado por ángulo (saturación):** `search_ads` con `keyword_mode=all`, `keywords=["<producto>", "<ángulo>"]`, `search_in=ad_copy`, `status=active`, `limit=1`. Lee "Total matches". Cuesta ~2 créditos por ángulo: mide 10 a 14 ángulos.

**Qué está creciendo esta semana:** `search_ads` con `query=<problema>`, `search_in=ad_copy`, `sort_by=reachDelta7d`, `status=active`, `max_ads_per_brand=1`.

## Trampas conocidas

- `max_ads_per_brand` solo acepta 1.
- `sort_by=reachDelta30d` no existe en `search_ads`. Usa `reachDelta7d`.
- La búsqueda por dominio a veces trae marcas ajenas (por ejemplo, oneskin.co devolvió anuncios de otra marca). Verifica que la página y la landing coincidan.
- Algunas palabras clave dan conteos inflados (por ejemplo "skin" o "biofilm"). Tómalos como orden de magnitud y dilo.
- Para la etiqueta o el precio de un producto, busca primero con `web_buscar` y lee la URL con `web_leer`.
- Las landings de Shopify suelen no poder abrirse: reporta título y URL.
- Los anuncios de marcas que pautan en la UE (Suecia, Reino Unido, Alemania…) tienen alcance confiable. Los de EE. UU., no.
- Cifras de la ficha que no cuadran (por ejemplo, unidades mayores que la mitad de las visitas): señálalas como dato a revisar.
- Una misma fórmula vendida con dos nombres y precios (uno por ángulo) es un patrón real: búscalo comparando guiones y catálogo.
