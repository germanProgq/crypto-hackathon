# Справочник запросов

Этот документ перечисляет все HTTP и WebSocket запросы, предоставляемые сервисами репозитория, включая входные/выходные данные, требования аутентификации и типичные ошибки.

## Карта сервисов (порты Docker по умолчанию)

| Сервис | URL | Описание |
|--------|-----|----------|
| Auction Engine | http://127.0.0.1:4001 | Движок аукционов |
| Ledger | http://127.0.0.1:4002 | Журнал операций |
| Crypto Gateway | http://127.0.0.1:4003 | Крипто-шлюз |
| Bot | http://127.0.0.1:4004 | Telegram бот |
| Web | http://127.0.0.1:4005 | Web интерфейс |
| Workers | http://127.0.0.1:4006 | Фоновые воркеры |
| Signer | http://127.0.0.1:4007 | Подписант транзакций |
| Mock RPC | http://127.0.0.1:9000 | Мок-сервер для разработки |

## Соглашения

- JSON запросы/ответы используют `Content-Type: application/json`
- Все временные метки — строки ISO 8601 в ответах
- Object ID — 24-символьные hex строки, если не указано иное
- Формат ответов с ошибками:
  - `{ "error": "код", "message": "Человекочитаемое сообщение" }`
- Идемпотентность:
  - Многие операции записи принимают `idempotencyKey`. При повторном запросе с тем же ключом и payload возвращается предыдущий результат. Другой payload с тем же ключом возвращает 409.

---

## Аутентификация

### Core auth (auction-engine, ledger, crypto-gateway)

| Метод | Заголовок |
|-------|-----------|
| Сервисный токен | `x-service-token: <CORE_API_TOKEN>` или `Authorization: Bearer <CORE_API_TOKEN>` |
| Telegram пользователь | `x-telegram-init-data: <initData>` или `Authorization: TMA <initData>` |
| Demo пользователь (только dev) | `x-demo-user-id: <userId>` |

### Crypto admin auth (crypto-gateway admin endpoints)

| Метод | Заголовок |
|-------|-----------|
| Админ токен | `x-admin-token: <CRYPTO_ADMIN_TOKEN>` |

### Signer auth

| Метод | Заголовок |
|-------|-----------|
| Signer токен | `x-signer-token: <SIGNER_API_TOKEN>` |
| IP allowlist | Проверяется по `SIGNER_ALLOWED_IPS` |

### Web CSRF/CORS

- Небезопасные методы (POST/PUT/PATCH/DELETE) требуют заголовок `Origin`
- Запросы с отсутствующим/невалидным Origin возвращают `403` с `error: "csrf_failed"` или `cors_rejected`

---

## Общие эндпоинты (все сервисы)

### GET /health/live
Ответ 200:
```json
{
  "status": "ok",
  "service": "service-name",
  "timestamp": "2026-01-22T00:00:00.000Z"
}
```

### GET /health/ready
Ответ 200 (или 503 если зависимость недоступна):
```json
{
  "status": "ok | degraded",
  "service": "service-name",
  "timestamp": "2026-01-22T00:00:00.000Z",
  "checks": [
    { "name": "mongo|redis|...", "ok": true, "detail": "..." }
  ]
}
```

### GET /metrics
Prometheus метрики в текстовом формате.

---

## Auction Engine (4001)

### Аутентификация
- Чтение: core auth (сервисный токен или пользовательская auth)
- Создание аукционов: требуется сервисный токен

### GET /auctions
Получение списка аукционов.

**Query параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `status` | string | `active`, `upcoming`, `closed` (по умолчанию `active`) |
| `limit` | integer | 1..100 |
| `cursor` | string | `"<ISO time>|<objectId>"` |

**Ответ 200:**
```json
{
  "items": [AuctionSummary],
  "nextCursor": "2026-01-22T00:00:00.000Z|<objectId>" | null
}
```

### POST /auctions
Создание нового аукциона.

**Auth:** требуется сервисный токен

**Body:**
```json
{
  "title": "string",
  "description": "string?",
  "currency": "string",
  "startsAt": "ISO date или number",
  "endsAt": "ISO date или number",
  "pricingMode": "first_price | cutoff",
  "rounds": [
    {
      "index": 0,
      "allocationSize": 5,
      "startAt": "ISO date или number",
      "endAt": "ISO date или number",
      "antiSniping": {
        "triggerWindowSeconds": 10,
        "extensionSeconds": 15,
        "maxExtensions": 3
      }
    }
  ]
}
```

**Ответ 201:**
```json
{ "auction": Auction }
```

### GET /auctions/:auctionId
Получение деталей аукциона.

**Auth:** требуется core auth

**Ответ 200:**
```json
{ "auction": Auction }
```

### GET /auctions/:auctionId/snapshot
Получение снапшота аукциона.

**Auth:** требуется core auth

**Ответ 200:**
```json
{ "snapshot": AuctionSnapshot }
```

### GET /auctions/:auctionId/rounds/:roundIndex/state
Получение состояния раунда.

**Auth:** требуется core auth

**Ответ 200:**
```json
{ "state": RoundStateResponse }
```

### POST /auctions/:auctionId/bids
Размещение ставки.

**Auth:** требуется core auth

**Body:**
```json
{
  "userId": "string?",
  "amount": 123.45,
  "idempotencyKey": "string",
  "metadata": { "любой": "объект" },
  "audit": {
    "requestId": "string?",
    "source": "string?",
    "ip": "string?",
    "userAgent": "string?",
    "actorId": "string?"
  }
}
```

**Ответ 200:**
```json
{
  "bid": Bid,
  "balance": LedgerBalance,
  "roundState": RoundState,
  "extended": true|false,
  "idempotent": true|false
}
```

### GET /auctions/:auctionId/rounds/:roundIndex/leaderboard
Получение лидерборда раунда.

**Auth:** требуется core auth

**Query параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `limit` | integer | 1..100 (по умолчанию 20) |

**Ответ 200:**
```json
{
  "roundIndex": 0,
  "leaderboard": [
    { "rank": 1, "userId": "...", "amount": 100.00, "createdAt": "ISO" }
  ]
}
```

### GET /auctions/:auctionId/replay
Replay раунда для верификации.

**Auth:** требуется core auth

**Ответ 200:**
```json
{
  "auctionId": "...",
  "roundIndex": 0,
  "bids": [...],
  "winners": [...],
  "merkleRoot": "...",
  "signature": "..."
}
```

### Схемы Auction Engine

**AuctionSummary:**
| Поле | Тип | Описание |
|------|-----|----------|
| `_id` | string | Идентификатор аукциона |
| `title` | string | Название |
| `description` | string | null | Описание |
| `status` | string | `draft`, `live`, `closed` |
| `currency` | string | Валюта |
| `startsAt` | ISO string | Время начала |
| `endsAt` | ISO string | Время окончания |
| `roundCount` | number | Количество раундов |
| `currentRoundIndex` | number | null | Текущий раунд |
| `roundStatus` | string | null | `scheduled`, `live`, `closed` |
| `roundEffectiveEndAt` | ISO string | null | Эффективное время окончания |
| `lastBidAmount` | number | null | Последняя ставка |

**Bid:**
| Поле | Тип | Описание |
|------|-----|----------|
| `_id` | string | Идентификатор ставки |
| `auctionId` | string | Идентификатор аукциона |
| `roundIndex` | number | null | Индекс раунда |
| `userId` | string | Идентификатор пользователя |
| `amount` | number | Сумма ставки |
| `createdAt` | ISO string | Время создания |
| `idempotencyKey` | string | Ключ идемпотентности |
| `active` | boolean | Активна ли ставка |

### Коды ошибок Auction Engine

| Код | Описание |
|-----|----------|
| `invalid_request` | Некорректный запрос |
| `auction_not_found` | Аукцион не найден |
| `auction_not_live` | Аукцион не активен |
| `round_not_found` | Раунд не найден |
| `round_not_live` | Раунд не активен |
| `bid_too_low` | Ставка ниже минимума |
| `round_locked` | Раунд заблокирован |
| `rate_limited` | Превышен лимит запросов |
| `idempotency_conflict` | Конфликт идемпотентности |

---

## Ledger (4002)

### Аутентификация
- GET эндпоинты: core auth
- POST эндпоинты: требуется сервисный токен

### GET /ledger/:userId/balance
Получение баланса пользователя.

**Query:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `currency` | string | Валюта (обязательно) |

**Ответ 200:**
```json
{
  "userId": "...",
  "currency": "USDT",
  "available": 100.00,
  "held": 50.00,
  "spent": 25.00,
  "current": 150.00,
  "asOf": "2026-01-22T00:00:00.000Z"
}
```

### GET /ledger/:userId/history
Получение истории операций.

**Query:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `currency` | string | Валюта (обязательно) |
| `limit` | integer | По умолчанию 50, max 200 |
| `before` | ISO date | Фильтр по времени |

**Ответ 200:**
```json
[LedgerEntry]
```

### POST /ledger/entries
Создание записи в журнале.

**Body:**
```json
{
  "userId": "string",
  "entryType": "deposit_confirmed|withdrawal_requested|...",
  "amount": 123.45,
  "currency": "string",
  "idempotencyKey": "string",
  "withdrawalId": "string?",
  "metadata": { "любой": "объект" },
  "audit": { ... }
}
```

**Ответ 200:**
```json
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds
Создание холда.

**Body:**
```json
{
  "userId": "string",
  "amount": 123.45,
  "currency": "string",
  "holdId": "string",
  "idempotencyKey": "string",
  "metadata": { ... },
  "audit": { ... }
}
```

**Ответ 200:**
```json
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds/release
Освобождение холда.

**Body:** То же, что `/ledger/holds`

**Ответ 200:**
```json
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### POST /ledger/holds/capture
Списание холда.

**Body:** То же, что `/ledger/holds`

**Ответ 200:**
```json
{ "entry": LedgerEntry, "balance": LedgerBalance }
```

### Схемы Ledger

**LedgerBalance:**
| Поле | Тип | Описание |
|------|-----|----------|
| `userId` | string | Идентификатор пользователя |
| `currency` | string | Валюта |
| `available` | number | Доступный баланс |
| `held` | number | Заблокировано |
| `spent` | number | Потрачено |
| `current` | number | Общий баланс (available + held) |
| `asOf` | ISO string | Время актуальности |

**LedgerEntry:**
| Поле | Тип | Описание |
|------|-----|----------|
| `_id` | string | Идентификатор записи |
| `userId` | string | Идентификатор пользователя |
| `entryType` | string | Тип операции |
| `amount` | number | Сумма |
| `currency` | string | Валюта |
| `createdAt` | ISO string | Время создания |
| `idempotencyKey` | string | Ключ идемпотентности |

**Типы операций (`entryType`):**
- `deposit_confirmed` — подтверждённый депозит
- `hold_created` — создан холд
- `hold_released` — холд освобождён
- `hold_captured` — холд списан
- `withdrawal_requested` — запрос на вывод
- `withdrawal_broadcasted` — вывод отправлен
- `withdrawal_confirmed` — вывод подтверждён
- `withdrawal_failed` — вывод не удался

### Коды ошибок Ledger

| Код | Описание |
|-----|----------|
| `invalid_request` | Некорректный запрос |
| `invalid_amount` | Некорректная сумма |
| `insufficient_funds` | Недостаточно средств |
| `idempotency_conflict` | Конфликт идемпотентности |
| `hold_exists` | Холд уже существует |
| `hold_not_found` | Холд не найден |
| `hold_resolved` | Холд уже разрешён |

---

## Crypto Gateway (4003)

### Аутентификация
- Пользовательские маршруты: core auth
- Админ маршруты: требуется админ токен

### GET /crypto/:userId/deposit-address
Получение адреса для депозита.

**Auth:** требуется core auth

**Query:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `currency` | string | Валюта (обязательно) |

**Ответ 200:**
```json
{
  "userId": "...",
  "currency": "USDT",
  "address": "...",
  "memo": "string | null",
  "strategy": "address_pool | memo_tag | address_per_user"
}
```

### POST /crypto/withdrawals/request
Запрос на вывод средств.

**Auth:** требуется core auth

**Body:**
```json
{
  "userId": "string?",
  "currency": "string",
  "amount": 123.45,
  "destinationAddress": "string",
  "memo": "string?",
  "idempotencyKey": "string"
}
```

**Ответ 200:**
```json
{
  "withdrawal": CryptoWithdrawal,
  "balance": LedgerBalance,
  "decision": "approve|review|reject",
  "flags": [ "string" ],
  "violations": [ "string" ],
  "anomalyScore": 25
}
```

### POST /crypto/withdrawals/:withdrawalId/authorize
Авторизация вывода (админ).

**Auth:** требуется админ токен

**Body:**
```json
{ "actorId": "string?" }
```

**Ответ 200:**
```json
{ "withdrawal": CryptoWithdrawal }
```

### GET /crypto/withdrawals/:withdrawalId
Получение статуса вывода.

**Auth:** требуется админ токен

**Ответ 200:**
```json
{ "withdrawal": CryptoWithdrawal }
```

### Схемы Crypto Gateway

**CryptoWithdrawal:**
| Поле | Тип | Описание |
|------|-----|----------|
| `_id` | string | Идентификатор вывода |
| `userId` | string | Идентификатор пользователя |
| `currency` | string | Валюта |
| `amount` | number | Сумма |
| `destinationAddress` | string | Адрес назначения |
| `memo` | string | null | Memo/tag |
| `status` | string | Статус вывода |
| `txId` | string | null | ID транзакции в блокчейне |
| `requestedAt` | ISO string | Время запроса |
| `flags` | string[] | Флаги безопасности |
| `reviewRequired` | boolean | Требуется ручной review |

**Статусы вывода:**
- `requested` — запрошен
- `authorized` — авторизован
- `broadcasted` — отправлен в сеть
- `confirmed` — подтверждён
- `failed` — не удался

### Коды ошибок Crypto Gateway

| Код | Описание |
|-----|----------|
| `invalid_request` | Некорректный запрос |
| `unsupported_currency` | Неподдерживаемая валюта |
| `withdrawal_not_found` | Вывод не найден |
| `withdrawal_conflict` | Конфликт вывода |
| `anomaly_detected` | Обнаружена аномалия (ML) |
| `address_not_allowed` | Адрес не в allowlist |

---

## Web (4005)

### Аутентификация
Telegram init data или demo user заголовок.

### GET /
Возвращает HTML. Опциональный `?lang=<locale>` для выбора локали.

### GET /api/session
Получение текущей сессии.

**Ответ 200:**
```json
{ "user": WebUser | null }
```

### GET /api/auctions
Получение списка аукционов.

**Ответ 200:**
```json
[ActiveAuctionPayload]
```

### POST /api/auctions
Создание аукциона.

**Auth:** требуется. Origin требуется.

**Body:**
```json
{
  "title": "string",
  "description": "string?",
  "currency": "string?",
  "rounds": 3,
  "allocationSize": 5,
  "roundDurationSeconds": 300,
  "startOffsetSeconds": 0,
  "antiSniping": {
    "triggerWindowSeconds": 10,
    "extensionSeconds": 15,
    "maxExtensions": 3
  }
}
```

**Ответ 201:**
```json
{ "_id": "<auctionId>", "status": "draft|live" }
```

### POST /api/auctions/:auctionId/bids
Размещение ставки.

**Auth:** требуется. Origin требуется.

**Body:**
```json
{ "amount": 123.45, "idempotencyKey": "string?" }
```

**Ответ 200:**
```json
{
  "bid": Bid,
  "balance": LedgerBalance,
  "roundState": RoundState,
  "extended": true|false,
  "idempotent": true|false
}
```

### GET /api/balance
Получение баланса.

**Auth:** требуется

**Query:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `currency` | string | По умолчанию "USDT" |

**Ответ 200:**
```json
LedgerBalance
```

### POST /api/crypto/withdrawals
Запрос на вывод.

**Auth:** требуется. Origin требуется.

**Body:**
```json
{
  "amount": 123.45,
  "currency": "string?",
  "destinationAddress": "string",
  "memo": "string?",
  "idempotencyKey": "string?"
}
```

**Ответ 200:**
```json
{
  "withdrawal": CryptoWithdrawal,
  "balance": LedgerBalance,
  "decision": "approve|review|reject",
  "flags": [ "string" ]
}
```

### GET /graphql
GraphQL API endpoint.

### GET /graphiql
GraphQL IDE интерфейс.

### GET /live-metrics
Дашборд метрик реального времени.

---

## WebSocket /ws

### Клиент → Сервер

```json
{ "type": "ping" }
{ "type": "auth", "initData": "<telegram init data>" }
{ "type": "auth", "demoUserId": "string" }
{ "type": "subscribe", "auctionId": "<id>" }
{ "type": "unsubscribe", "auctionId": "<id>" }
{ "type": "place_bid", "requestId": "uuid", "auctionId": "<id>", "amount": 100, "idempotencyKey": "..." }
```

### Сервер → Клиент

```json
{ "type": "pong" }
{ "type": "auth", "ok": true, "user": WebUser }
{ "type": "auth", "ok": false, "code": "auth_required", "message": "..." }
{ "type": "auctions", "data": [ActiveAuctionPayload] }
{ "type": "auction_snapshot", "data": RealtimeAuctionSnapshot }
{ "type": "bid_placed", "auctionId": "...", "userId": "...", "amount": 100, "rank": 5 }
{ "type": "outbid", "auctionId": "...", "yourBid": 100, "newTopBid": 150, "yourRank": 4 }
{ "type": "leaderboard_update", "auctionId": "...", "topBids": [...] }
{ "type": "anti_sniping_extension", "auctionId": "...", "newEndAt": "ISO", "extensionCount": 2 }
{ "type": "balance_update", "userId": "...", "available": 100, "held": 50, "current": 150 }
{ "type": "bid_result", "requestId": "uuid", "success": true, "rank": 5, "latencyMs": 5 }
```

---

## Signer (4007)

**Auth:** `x-signer-token` и IP allowlist.

### POST /signer/sign
Подпись транзакции вывода.

**Body:**
```json
{
  "withdrawalId": "string",
  "currency": "string",
  "amount": 123.45,
  "fromAddress": "string",
  "toAddress": "string",
  "requestedAt": "ISO string",
  "memo": "string?"
}
```

**Ответ 200:**
```json
{
  "signedPayload": {
    "payload": { ... },
    "signature": "base64",
    "publicKey": "base64",
    "algorithm": "ed25519",
    "signedAt": "ISO"
  }
}
```

---

## Mock RPC (9000)

Используется для мок-наблюдателя/подписанта.

### GET /observer/transactions
Получение транзакций.

**Query:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `currency` | string | Валюта (опционально) |
| `addresses` | string | Адреса через запятую |
| `after` | integer | Курсор (по умолчанию 0) |
| `limit` | integer | 1..200 (по умолчанию 100) |

### POST /mock/observer/mint
Создание тестового депозита.

**Body:**
```json
{
  "currency": "string",
  "address": "string",
  "memo": "string?",
  "amount": 100
}
```

**Ответ 200:**
```json
{ "txId": "string" }
```

### POST /mock/observer/mine
Добавление блоков (увеличение подтверждений).

**Body:**
```json
{ "blocks": 1 }
```

**Ответ 200:**
```json
{ "blockHeight": 12345 }
```

### POST /mock/observer/reset
Сброс состояния мока.

**Ответ 200:**
```json
{ "ok": true }
```

---

## Bot (4004) и Workers (4006)

Без кастомных HTTP маршрутов. Только общие эндпоинты:
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
