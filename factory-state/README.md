# Factory State

Estado em arquivos JSON da POC Fábrica Inteligente (SENAI). O webapp lê e escreve estes arquivos; os agentes (Vendas, PCP, Produção) também os manipulam diretamente via tools `Read`/`Write`/`Edit`.

Um watcher (`fs.watch`) em `webapp/server/src/factory.ts` observa esta pasta e re-broadcasta o estado completo para todos os clientes WS conectados (TV e tablet) sempre que algum arquivo muda. Debounce de 200ms.

## Schemas

### `inventory.json`

Dicionário `SKU → { name, stock, minStock, unit }`. Catálogo fixo da metalurgia.

```json
{
  "PAR-M8X40-INX-A2": {
    "name": "Parafuso sextavado M8x40 inox A2 (DIN 933)",
    "stock": 1200,
    "minStock": 200,
    "unit": "pç"
  }
}
```

### `orders.json`

Array de pedidos recebidos do tablet.

```json
[
  {
    "id": 1,
    "sku": "PAR-M8X40-INX-A2",
    "qty": 50,
    "status": "pending | accepted | in_production | done | rejected",
    "createdAt": "2026-05-12T10:00:00.000Z",
    "completedAt": "2026-05-12T10:02:30.000Z"
  }
]
```

### `production.json`

Ordens de Produção (OPs) criadas pelo PCP a partir de pedidos.

```json
[
  {
    "opId": 1,
    "orderId": 1,
    "sku": "PAR-M8X40-INX-A2",
    "qty": 50,
    "status": "queued | running | done",
    "startedAt": "2026-05-12T10:00:30.000Z",
    "finishedAt": "2026-05-12T10:02:30.000Z"
  }
]
```

### `kpis.json`

Indicadores agregados do dia. Atualizados pelo agente Produção ao concluir cada OP.

```json
{
  "ordersToday": 0,
  "leadTimeAvgMin": 0,
  "oeePercent": 0
}
```

## Reset

O botão "Reset Demo" no tablet zera `orders.json`, `production.json` e `kpis.json` para os valores default. `inventory.json` é restaurado para os estoques iniciais bakeados em `webapp/server/src/factory.ts`.
