-- IVB-024: saldo por variante de la corrida (suma de movimientos, R3) y conteos y propuestas pendientes.
-- $1 = run_id (NULL sin corrida), $2 = negocio. Solo lectura. Se toma antes y después de cada puerta humana:
-- el «negativo en vivo» del paso 2 es este saldo igual antes y después de «Conté 22», hasta confirmar.
SELECT p.name AS producto, v.name AS variante, v.id::text AS variante_id, v.unit_cost AS costo,
       COALESCE((SELECT sum(m.delta) FROM assistant.stock_movements m
                  WHERE m.variant_id = v.id AND m.run_id IS NOT DISTINCT FROM $1::uuid), 0)::int AS saldo,
       (SELECT count(*) FROM assistant.stock_movements m
         WHERE m.variant_id = v.id AND m.run_id IS NOT DISTINCT FROM $1::uuid)::int AS movimientos,
       (SELECT count(*) FROM assistant.stock_proposals q
         WHERE q.business_id = $2::uuid AND q.run_id IS NOT DISTINCT FROM $1::uuid AND q.status = 'pendiente'
           AND q.payload ->> 'variante_id' = v.id::text)::int AS propuestas_pendientes
  FROM assistant.stock_variants v
  JOIN assistant.stock_products p ON p.id = v.product_id
 WHERE p.business_id = $2::uuid AND p.run_id IS NOT DISTINCT FROM $1::uuid
 ORDER BY p.name, v.name;
