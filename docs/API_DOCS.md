# Документация API

## Обзор

Платформа Crypto Auction предоставляет комплексную документацию API через OpenAPI (Swagger) для HTTP-эндпоинтов и AsyncAPI для WebSocket-событий.

---

## HTTP API документация (OpenAPI/Swagger)

Интерактивный Swagger UI доступен по следующим адресам при запущенных сервисах:

- **Auction Engine**: [http://localhost:4001/api/docs](http://localhost:4001/api/docs)
- **Ledger Service**: [http://localhost:4002/api/docs](http://localhost:4002/api/docs)
- **Crypto Gateway**: [http://localhost:4003/api/docs](http://localhost:4003/api/docs)
- **Web Service**: [http://localhost:4005/api/docs](http://localhost:4005/api/docs)

### Возможности

- **Интерактивный API Explorer**: Тестирование эндпоинтов прямо из браузера
- **Схемы запросов/ответов**: Полные TypeScript-совместимые определения типов
- **Аутентификация**: Документация сервисного токена и JWT bearer auth
- **Длительность запросов**: Отслеживание латентности API-вызовов в реальном времени
- **Глубокие ссылки**: Прямые ссылки на конкретные эндпоинты
- **Фильтрация**: Поиск и фильтрация эндпоинтов по тегам

---

## Ключевые эндпоинты

### Auction Engine (Порт 4001)

| Метод | Путь | Описание |
|-------|------|----------|
| `POST` | `/auctions` | Создание нового аукциона |
| `GET` | `/auctions/:id` | Получение деталей аукциона |
| `POST` | `/auctions/:id/bids` | Размещение ставки |
| `GET` | `/auctions/:id/rounds/:index/leaderboard` | Получение лидерборда раунда |
| `GET` | `/auctions/:id/replay` | Replay раунда для верификации |
| `POST` | `/auctions/:id/start` | Запуск аукциона |

### Ledger Service (Порт 4002)

| Метод | Путь | Описание |
|-------|------|----------|
| `POST` | `/ledger/deposit` | Запись депозита |
| `POST` | `/ledger/hold` | Создание холда на балансе |
| `POST` | `/ledger/capture` | Списание заблокированной суммы |
| `POST` | `/ledger/release` | Освобождение холда |
| `GET` | `/ledger/:userId/balance` | Получение баланса пользователя |
| `GET` | `/ledger/:userId/history` | История операций |

### Crypto Gateway (Порт 4003)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/crypto/:userId/deposit-address` | Получение адреса депозита |
| `POST` | `/crypto/withdrawal` | Запрос на вывод криптовалюты |
| `GET` | `/crypto/withdrawal/:id` | Статус вывода |
| `POST` | `/crypto/admin/deposits/confirm` | Подтверждение депозита (админ) |
| `GET` | `/crypto/withdrawal/:id/anomaly-score` | ML-оценка аномальности |

### Web Service (Порт 4005)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/` | Web UI |
| `GET` | `/ws` | WebSocket подключение |
| `GET` | `/api/auctions` | Список аукционов (публичный) |
| `GET` | `/api/auctions/:id` | Детали аукциона (публичный) |
| `POST` | `/graphql` | GraphQL API endpoint |
| `GET` | `/graphiql` | GraphQL IDE |
| `GET` | `/live-metrics` | Дашборд метрик |

---

## GraphQL API

### Подключение

```
HTTP endpoint: POST http://localhost:4005/graphql
GraphiQL IDE: http://localhost:4005/graphiql
```

### Схема

```graphql
type Query {
  # Получить аукционы с пагинацией
  auctions(
    first: Int = 10
    after: String
    status: String
  ): AuctionConnection!
  
  # Получить один аукцион
  auction(id: ID!): Auction
  
  # Получить баланс пользователя
  balance(userId: String!, currency: String!): Balance!
}

type Mutation {
  # Разместить ставку
  placeBid(
    auctionId: ID!
    amount: Float!
    idempotencyKey: String!
  ): Bid!
}

type Auction {
  id: ID!
  title: String!
  status: String!
  currency: String!
  currentRound: Int
  topBid: Float
  endsAt: String
}

type Bid {
  id: ID!
  amount: Float!
  rank: Int!
  createdAt: String!
}

type Balance {
  available: Float!
  held: Float!
  current: Float!
  spent: Float!
  currency: String!
}
```

### Примеры запросов

```graphql
# Получить активные аукционы
query GetLiveAuctions {
  auctions(first: 10, status: "live") {
    edges {
      node {
        id
        title
        topBid
        endsAt
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}

# Разместить ставку
mutation PlaceBid {
  placeBid(
    auctionId: "507f1f77bcf86cd799439011"
    amount: 150.50
    idempotencyKey: "unique-key-abc123"
  ) {
    id
    amount
    rank
    createdAt
  }
}
```

---

## WebSocket API документация (AsyncAPI)

Полная спецификация AsyncAPI доступна в файле: [`docs/asyncapi.yaml`](./asyncapi.yaml)

### Подключение

```javascript
const ws = new WebSocket('ws://localhost:4005/ws');

// Аутентификация после подключения
ws.send(JSON.stringify({
  type: 'authenticate',
  token: 'your-jwt-token'
}));
```

### Turbo Bid размещение

Размещайте ставки напрямую через WebSocket для сверхнизкой латентности (3-5ms):

```javascript
ws.send(JSON.stringify({
  type: 'place_bid',
  requestId: crypto.randomUUID(),
  auctionId: '507f1f77bcf86cd799439011',
  amount: 100.50,
  idempotencyKey: crypto.randomUUID()
}));

// Получение результата
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'bid_result') {
    console.log('Ставка размещена:', data.success);
    console.log('Латентность:', data.latencyMs, 'ms');
    console.log('Ранг:', data.rank);
  }
};
```

### Подписка на события

#### Обновления ставок

```javascript
// Подписка на комнату аукциона
ws.send(JSON.stringify({
  type: 'join_room',
  room: 'auction:507f1f77bcf86cd799439011'
}));

// Получение уведомлений о ставках
{
  "type": "bid_placed",
  "auctionId": "507f1f77bcf86cd799439011",
  "userId": "user123",
  "amount": 100.50,
  "rank": 5,
  "timestamp": "2026-01-22T20:00:00.000Z"
}
```

#### Обновления лидерборда (батчами каждые 150ms)

```javascript
{
  "type": "leaderboard_update",
  "auctionId": "507f1f77bcf86cd799439011",
  "roundIndex": 0,
  "topBids": [
    { "rank": 1, "userId": "user456", "amount": 200.00, "isCurrentUser": false },
    { "rank": 2, "userId": "user123", "amount": 150.75, "isCurrentUser": true },
    { "rank": 3, "userId": "user789", "amount": 120.25, "isCurrentUser": false }
  ],
  "timestamp": "2026-01-22T20:00:00.150Z"
}
```

#### Anti-Sniping продления

```javascript
{
  "type": "anti_sniping_extension",
  "auctionId": "507f1f77bcf86cd799439011",
  "roundIndex": 0,
  "previousEndAt": "2026-01-22T20:00:00.000Z",
  "newEndAt": "2026-01-22T20:00:30.000Z",
  "extensionCount": 1,
  "maxExtensions": 5
}
```

#### Обновления баланса

```javascript
{
  "type": "balance_update",
  "userId": "user123",
  "currency": "USDT",
  "available": 850.00,
  "held": 150.00,
  "current": 1000.00,
  "reason": "hold"
}
```

#### Уведомления о перебитии

```javascript
{
  "type": "outbid",
  "auctionId": "507f1f77bcf86cd799439011",
  "roundIndex": 0,
  "yourBid": 150.00,
  "newTopBid": 175.50,
  "yourRank": 4,
  "winnersCount": 3
}
```

---

## Метрики производительности

### HTTP эндпоинты

| Метрика | Значение |
|---------|----------|
| Средняя латентность | 10-50ms (в зависимости от операции) |
| p99 латентность | <200ms |
| Пропускная способность | 5,000+ запросов/сек на сервис |

### WebSocket Turbo Mode

| Метрика | Значение |
|---------|----------|
| Латентность размещения ставки | 3-5ms (p99) |
| Пропускная способность | 30,000+ ставок/сек |
| Ёмкость подключений | 10,000+ одновременных |

### Производительность бродкастов

| Метрика | Значение |
|---------|----------|
| Обновления лидерборда | Батчами каждые 150ms |
| Уведомления о ставках | Реального времени (<10ms) |
| Fan-out | 1,000+ подписчиков на комнату |

---

## Аутентификация

### Сервисный токен (межсервисный)

```bash
curl -H "x-service-token: ${CORE_API_TOKEN}" \
  http://localhost:4001/auctions
```

### JWT Bearer (пользователь)

```bash
curl -H "Authorization: Bearer ${JWT_TOKEN}" \
  http://localhost:4005/api/auctions
```

### Telegram Mini App

```bash
curl -H "Authorization: TMA ${INIT_DATA}" \
  http://localhost:4005/api/balance
```

---

## Лимиты частоты (Rate Limiting)

| Тип | Лимит |
|-----|-------|
| На пользователя | 5 запросов/сек |
| На пользователя в аукционе | 3 запроса/сек |
| На IP адрес | 20 запросов/сек |

---

## Обработка ошибок

Все ошибки следуют единому формату:

```json
{
  "error": "Человекочитаемое сообщение об ошибке",
  "code": "machine_readable_error_code"
}
```

### Коды ошибок

| Код | Описание |
|-----|----------|
| `insufficient_funds` | Недостаточно средств |
| `auction_closed` | Раунд аукциона закрыт |
| `bid_too_low` | Ставка ниже минимального инкремента |
| `invalid_request` | Ошибка валидации |
| `rate_limited` | Слишком много запросов |
| `internal_error` | Внутренняя ошибка сервера |
| `idempotency_conflict` | Ключ идемпотентности уже использован |
| `round_not_live` | Раунд не в статусе live |

---

## Генерация SDK

TypeScript SDK может быть автоматически сгенерирован из OpenAPI спецификации:

```bash
# Генерация SDK
npm run sdk:generate

# Сборка SDK
npm run sdk:build

# Использование SDK
import { CryptoAuctionClient } from '@crypto-auction/sdk';

const client = new CryptoAuctionClient({
  baseUrl: 'http://localhost:4001',
  token: 'your-token'
});

const auctions = await client.listAuctions({ status: 'live' });
```

---

## Просмотр AsyncAPI документации

Установите AsyncAPI CLI для генерации HTML документации:

```bash
npm install -g @asyncapi/cli
asyncapi generate fromFile docs/asyncapi.yaml @asyncapi/html-template -o docs/asyncapi-html
```

Затем откройте `docs/asyncapi-html/index.html` в браузере.

---

## Webhook API

### Регистрация вебхука

```bash
POST /api/webhooks
Content-Type: application/json

{
  "url": "https://your-server.com/webhook",
  "events": ["round_complete", "outbid", "deposit_confirmed"],
  "secret": "your-webhook-secret"
}
```

### Формат доставки

```json
{
  "event": "round_complete",
  "timestamp": "2026-01-22T12:00:00.000Z",
  "webhookId": "wh_abc123",
  "data": {
    "auctionId": "507f1f77bcf86cd799439011",
    "roundIndex": 0,
    "winners": [...]
  }
}
```

### Заголовки запроса

| Заголовок | Описание |
|-----------|----------|
| `X-Webhook-Signature` | HMAC-SHA256 подпись: `sha256=...` |
| `X-Webhook-Timestamp` | Unix timestamp отправки |
| `X-Webhook-ID` | Уникальный ID доставки |

### Проверка подписи

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return `sha256=${expected}` === signature;
}
```

### Политика повторов

| Попытка | Задержка |
|---------|----------|
| 1 | Немедленно |
| 2 | 30 секунд |
| 3 | 2 минуты |
| 4 | 10 минут |
| 5 | 1 час |

После 5 неудачных попыток вебхук деактивируется.
