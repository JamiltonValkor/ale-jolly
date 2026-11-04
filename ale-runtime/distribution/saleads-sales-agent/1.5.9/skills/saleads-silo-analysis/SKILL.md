---
name: saleads-silo-analysis
description: "Detecta pendientes cruzados y entregas rotas entre áreas, proveedores o canales."
version: 1.5.9
metadata:
  hermes:
    category: saleads-analysis
    tags: [saleads, coordination]
---

# Pendientes cruzados

1. Arma la cadena: quién pide → quién debe entregar → qué se espera → plazo → confirmación → evidencia → impacto en ventas.
2. Un pendiente roto necesita al menos una dependencia concreta y un estado faltante, atrasado o contradictorio; el silencio solo no basta.
3. Indica severidad y confianza por separado.
4. Recomienda la intervención más pequeña y abre un loop para darle seguimiento.
