# 🎯 Платформа аукционов Telegram Gift Auctions

> Боевой Telegram-стек для многораундовых крипто-аукционов с криптографической проверяемостью, ledger-first финансами и мгновенными обновлениями.

[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.0-green.svg)](https://www.mongodb.com/)
[![Redis](https://img.shields.io/badge/Redis-7.2-red.svg)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue.svg)](https://docs.docker.com/compose/)

---

## 📋 Содержание

- [Понимание механики Telegram Gift Auctions](#понимание-механики)
- [Архитектура системы](#архитектура-системы)
- [Ключевые гарантии](#ключевые-гарантии)
- [Потоки данных](#потоки-данных)
- [Сервисы и порты](#сервисы-и-порты)
- [Доменные сущности](#доменные-сущности)
- [Быстрый старт](#быстрый-старт)
- [API Reference](#api-reference)
- [Нагрузочное тестирование](#нагрузочное-тестирование)
- [Конфигурация](#конфигурация)

---

<a id="понимание-механики"></a>
## 🎮 Понимание механики Telegram Gift Auctions

### Как мы поняли механику

Изучив работу Telegram Gift Auctions, мы выявили ключевые особенности, отличающие её от классических аукционов:

```mermaid
flowchart TD
    subgraph "Многораундовая система"
        A[🎁 Аукцион: 100 лотов] --> B[Раунд 1: 30 лотов]
        B --> C[Раунд 2: 40 лотов]
        C --> D[Раунд 3: 30 лотов]
    end
    
    subgraph "Логика раунда"
        B --> E{Топ-30 ставок}
        E -->|Победители| F[💰 Списание средств]
        E -->|Остальные| G[↩️ Перенос в Раунд 2]
    end
    
    style A fill:#4CAF50,color:#fff
    style F fill:#2196F3,color:#fff
    style G fill:#FF9800,color:#fff
```

### Наши допущения

| Аспект | Допущение | Обоснование |
|--------|-----------|-------------|
| **Одна ставка на пользователя** | Пользователь имеет одну активную ставку на аукцион | Упрощает UX и предотвращает самоперебивание |
| **Перенос ставок** | Непобедившие ставки автоматически переносятся в следующий раунд | Снижает барьер для продолжения участия |
| **Ранжирование** | Сумма DESC → Время ASC → ID ставки ASC | Детерминированный порядок, раннее время предпочтительнее |
| **Anti-sniping** | Продление раунда при ставках в последние N секунд | Защита от ботов, ставящих в последнюю миллисекунду |
| **Блокировка средств** | Сумма ставки блокируется сразу, списывается при победе | Гарантия платежеспособности победителей |

### Жизненный цикл раунда

```mermaid
stateDiagram-v2
    [*] --> scheduled: Создание аукциона
    scheduled --> live: Время старта
    live --> extended: Ставка в anti-sniping окне
    extended --> live: Продление завершено
    live --> closed: Время окончания
    extended --> closed: Лимит продлений
    closed --> finalized: Расчёт победителей
    finalized --> [*]: Все раунды завершены
    
    note right of extended
        Максимум продлений
        ограничен конфигурацией
    end note
    
    note right of finalized
        Победители: списание
        Остальные: перенос/возврат
    end note
```

---

<a id="архитектура-системы"></a>
## 🏗️ Архитектура системы

### Высокоуровневая архитектура

```mermaid
flowchart TB
    subgraph "Клиенты"
        WEB[🌐 Web UI]
        TG[📱 Telegram Bot]
        API[🔌 External API]
    end
    
    subgraph "Gateway Layer"
        WEBSERV[Web Service<br/>:4005]
        BOT[Bot Service<br/>:4004]
    end
    
    subgraph "Core Services"
        AE[⚙️ Auction Engine<br/>:4001]
        LED[📒 Ledger<br/>:4002]
        CG[💳 Crypto Gateway<br/>:4003]
        WORK[⏰ Workers<br/>:4006]
    end
    
    subgraph "Crypto Layer"
        SIGN[🔐 Signer<br/>:4007]
        MOCK[🎭 Mock RPC<br/>:9000]
    end
    
    subgraph "Storage Layer"
        MONGO[(MongoDB<br/>Replica Set)]
        REDIS[(Redis<br/>Pub/Sub + Cache)]
    end
    
    WEB --> WEBSERV
    TG --> BOT
    API --> AE
    
    WEBSERV --> AE
    WEBSERV --> LED
    WEBSERV --> CG
    BOT --> AE
    
    AE --> MONGO
    AE --> REDIS
    LED --> MONGO
    CG --> SIGN
    CG --> MOCK
    WORK --> AE
    WORK --> LED
    
    SIGN --> MONGO
    
    style AE fill:#4CAF50,color:#fff
    style LED fill:#2196F3,color:#fff
    style CG fill:#9C27B0,color:#fff
    style SIGN fill:#FF5722,color:#fff
```

### Ответственность сервисов

| Сервис | Порт | Ответственность |
|--------|------|-----------------|
| **Auction Engine** | 4001 | CRUD аукционов, ставки, снимки раундов, кэш ранжирования |
| **Ledger** | 4002 | Балансы, hold/capture/release, журнал операций |
| **Crypto Gateway** | 4003 | Депозиты, выводы, проверки безопасности |
| **Bot** | 4004 | Telegram-обработчики, уведомления |
| **Web** | 4005 | HTTP API, WebSocket, статика |
| **Workers** | 4006 | Прогресс раундов, финализация |
| **Signer** | 4007 | Подпись транзакций (локальные ключи / KMS) |
| **Mock RPC** | 9000 | Мок наблюдателя и подписанта для разработки |

---

<a id="ключевые-гарантии"></a>
## 🛡️ Ключевые гарантии

### Криптографическая проверяемость

```mermaid
flowchart LR
    subgraph "Раунд N"
        B1[Ставка 1] --> HASH1[Hash]
        B2[Ставка 2] --> HASH2[Hash]
        B3[Ставка 3] --> HASH3[Hash]
        BN[Ставка N] --> HASHN[Hash]
    end
    
    HASH1 --> MERKLE[🌳 Merkle Root]
    HASH2 --> MERKLE
    HASH3 --> MERKLE
    HASHN --> MERKLE
    
    MERKLE --> PAYLOAD[Round Payload]
    PAYLOAD --> SIG[🔐 Подпись сервера]
    
    SIG --> VERIFY{Верификация}
    VERIFY -->|✅| VALID[Честный раунд]
    VERIFY -->|❌| INVALID[Манипуляция!]
    
    style MERKLE fill:#4CAF50,color:#fff
    style SIG fill:#2196F3,color:#fff
    style VALID fill:#4CAF50,color:#fff
    style INVALID fill:#f44336,color:#fff
```

### Финансовая модель (Ledger-first)

```mermaid
sequenceDiagram
    participant User as 👤 Пользователь
    participant Engine as ⚙️ Auction Engine
    participant Ledger as 📒 Ledger
    participant Redis as 🔴 Redis
    
    User->>Engine: POST /bids (amount: 100)
    
    activate Engine
    Engine->>Redis: Проверка rate limit
    Redis-->>Engine: OK
    
    Engine->>Redis: Distributed lock (userId + auctionId)
    Redis-->>Engine: Lock acquired
    
    Engine->>Ledger: hold(userId, 100, idempotencyKey)
    
    activate Ledger
    Note over Ledger: Append-only запись:<br/>type: "hold"<br/>amount: 100<br/>ref: bidId
    Ledger-->>Engine: holdId
    deactivate Ledger
    
    Engine->>Engine: Сохранить ставку в MongoDB
    Engine->>Redis: ZADD ranking (score, bidId)
    
    Engine->>Redis: Release lock
    Engine-->>User: 201 Created
    deactivate Engine
    
    Note over Ledger: При победе: capture(holdId)<br/>При проигрыше: release(holdId)
```

### Гарантии системы

| Гарантия | Реализация |
|----------|------------|
| **Детерминированность** | Одинаковые входные данные → одинаковые результаты |
| **Идемпотентность** | Все денежные операции используют idempotencyKey |
| **Полный аудит** | Журнал append-only для восстановления истории |
| **Проверяемость** | Merkle-корни и подписи раундов |
| **Безопасная конкуренция** | Распределённые блокировки Redis |
| **Изоляция сбоев** | Микросервисы независимы |

---

<a id="потоки-данных"></a>
## 🔄 Потоки данных

### Размещение ставки

```mermaid
sequenceDiagram
    autonumber
    participant Client as 🌐 Клиент
    participant Web as Web Service
    participant Engine as Auction Engine
    participant Ledger as Ledger
    participant Redis as Redis
    participant Mongo as MongoDB
    
    Client->>Web: POST /api/auctions/:id/bid
    Web->>Engine: Forward request
    
    Engine->>Redis: Rate limit check
    alt Rate limit exceeded
        Redis-->>Engine: REJECTED
        Engine-->>Client: 429 Too Many Requests
    end
    
    Engine->>Redis: SETNX lock:user:auction
    
    Engine->>Ledger: hold(amount)
    Ledger->>Mongo: Insert ledger entry
    Ledger-->>Engine: holdId
    
    Engine->>Mongo: Insert/Update bid
    Engine->>Redis: ZADD bids:auction:round
    
    alt Ставка в anti-sniping окне
        Engine->>Mongo: Extend round endTime
        Engine->>Redis: PUBLISH anti-sniping-extended
    end
    
    Engine->>Redis: PUBLISH new-bid
    Engine->>Redis: DEL lock:user:auction
    
    Engine-->>Client: 201 Created (bid)
    
    Redis-->>Web: SUB new-bid
    Web-->>Client: WS: bid-placed event
```

### Финализация раунда

```mermaid
sequenceDiagram
    autonumber
    participant Scheduler as ⏰ Scheduler
    participant Engine as Auction Engine
    participant Ledger as Ledger
    participant Mongo as MongoDB
    participant Redis as Redis
    
    Scheduler->>Engine: Round end trigger
    
    Engine->>Redis: SETNX lock:finalize:round
    
    Engine->>Redis: ZREVRANGE bids (top N)
    Engine->>Engine: Determine winners
    
    loop Для каждого победителя
        Engine->>Ledger: capture(holdId)
        Ledger->>Mongo: Insert ledger entry
    end
    
    loop Для каждого проигравшего
        alt Есть следующий раунд
            Engine->>Engine: Перенос ставки
        else Последний раунд
            Engine->>Ledger: release(holdId)
        end
    end
    
    Engine->>Engine: Compute Merkle root
    Engine->>Engine: Sign round results
    
    Engine->>Mongo: Save round results
    Engine->>Redis: PUBLISH round-complete
    Engine->>Redis: DEL lock:finalize:round
    
    Note over Engine: Результаты подписаны<br/>и доступны для верификации
```

### Депозиты и выводы

```mermaid
flowchart TB
    subgraph "Депозиты"
        OBS[🔍 Observer] -->|Новая TX| CG[Crypto Gateway]
        CG -->|Стратегия| STRAT{Wallet Strategy}
        STRAT -->|address_pool| POOL[Пул адресов]
        STRAT -->|memo_tag| MEMO[Memo тег]
        STRAT -->|address_per_user| HD[HD Wallet]
        POOL --> ATTR[Атрибуция]
        MEMO --> ATTR
        HD --> ATTR
        ATTR -->|Подтверждения ≥ N| LED2[Ledger: deposit]
    end
    
    subgraph "Выводы"
        REQ[📤 Запрос вывода] --> VALID{Валидация}
        VALID -->|allowlist| CHECK1[✓]
        VALID -->|cooldown| CHECK2[✓]
        VALID -->|limits| CHECK3[✓]
        VALID -->|anomaly| CHECK4[✓]
        
        CHECK1 --> AUTH{Авторизация}
        CHECK2 --> AUTH
        CHECK3 --> AUTH
        CHECK4 --> AUTH
        
        AUTH -->|auto ≤ threshold| AUTO[Авто-одобрение]
        AUTH -->|manual| ADMIN[Админ-одобрение]
        
        AUTO --> SIGN2[🔐 Signer]
        ADMIN --> SIGN2
        SIGN2 --> BROADCAST[📡 Broadcast]
        BROADCAST --> CONFIRM[✅ Подтверждения]
    end
    
    style OBS fill:#4CAF50,color:#fff
    style SIGN2 fill:#FF5722,color:#fff
```

---

<a id="сервисы-и-порты"></a>
## 🔌 Сервисы и порты

```
┌─────────────────────────────────────────────────────────────────┐
│                     DOCKER COMPOSE STACK                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Auction      │  │ Ledger       │  │ Crypto       │           │
│  │ Engine       │  │              │  │ Gateway      │           │
│  │ :4001        │  │ :4002        │  │ :4003        │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Bot          │  │ Web UI       │  │ Workers      │           │
│  │              │  │              │  │              │           │
│  │ :4004        │  │ :4005        │  │ :4006        │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ Signer       │  │ Mock RPC     │                             │
│  │              │  │              │                             │
│  │ :4007        │  │ :9000        │                             │
│  └──────────────┘  └──────────────┘                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐           │
│  │                   MongoDB :27017                  │           │
│  │                   (Replica Set)                   │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐           │
│  │                   Redis :6379                     │           │
│  │                   (Pub/Sub + Cache)               │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

<a id="доменные-сущности"></a>
## 📦 Доменные сущности

```mermaid
erDiagram
    AUCTION ||--o{ ROUND : contains
    ROUND ||--o{ BID : contains
    USER ||--o{ BID : places
    USER ||--o{ LEDGER_ENTRY : has
    AUCTION ||--o{ WINNER : determines
    
    AUCTION {
        ObjectId id PK
        string title
        string currency
        Date startsAt
        Date endsAt
        int totalItems
        object antiSnipingConfig
        string status
    }
    
    ROUND {
        ObjectId id PK
        ObjectId auctionId FK
        int roundNumber
        int itemsToDistribute
        Date startsAt
        Date endsAt
        string status
        string merkleRoot
        string signature
    }
    
    BID {
        ObjectId id PK
        ObjectId auctionId FK
        ObjectId roundId FK
        string odUserId
        int amount
        Date createdAt
        string idempotencyKey UK
        string origin
    }
    
    USER {
        string odUserId PK
        int balance
        int frozenBalance
        Date createdAt
    }
    
    LEDGER_ENTRY {
        ObjectId id PK
        string userId FK
        string type
        int amount
        string currency
        string refType
        ObjectId refId
        string idempotencyKey UK
        Date createdAt
    }
    
    WINNER {
        ObjectId id PK
        ObjectId auctionId FK
        ObjectId roundId FK
        ObjectId bidId FK
        string userId
        int amount
        Date createdAt
    }
```

---

<a id="быстрый-старт"></a>
## 🚀 Быстрый старт

### Требования

- Node.js 20+
- Docker & Docker Compose
- Git

### Установка и запуск

```bash
# 1. Клонирование репозитория
git clone https://github.com/your-org/crypto-hackathon.git
cd crypto-hackathon

# 2. Установка зависимостей
npm install

# 3. Запуск всех сервисов
docker compose up -d

# 4. Проверка статуса
docker compose ps

# 5. Открыть Web UI
open http://localhost:4005
```

### Минимальный .env для разработки

```env
CORE_API_TOKEN=dev-core-token
CRYPTO_ADMIN_TOKEN=dev-admin-token
SIGNER_API_TOKEN=dev-signer-token
CRYPTO_SIGNER_TOKEN=dev-signer-token
CRYPTO_SUPPORTED_CURRENCIES=USDT
CRYPTO_USD_RATES=USDT:1
CRYPTO_WALLET_STRATEGY=memo_tag
CRYPTO_MEMO_DEPOSIT_ADDRESS=USDT:DEMO_DEPOSIT_ADDRESS
CRYPTO_HOT_WALLET_ADDRESS=USDT:DEMO_HOT_WALLET
CRYPTO_OBSERVER_URL=mock
CRYPTO_SIGNER_URL=mock
WEB_ALLOW_DEMO_USER=true
```

### Проверка работоспособности

```bash
# Health check
curl http://localhost:4001/health/ready

# Создание тестового аукциона
curl -X POST http://localhost:4005/api/auctions \
  -H "Content-Type: application/json" \
  -H "x-demo-user-id: demo-admin" \
  -d '{
    "title": "Test Auction",
    "currency": "USDT",
    "totalItems": 10,
    "rounds": [
      { "itemsToDistribute": 3, "durationSeconds": 120 },
      { "itemsToDistribute": 4, "durationSeconds": 120 },
      { "itemsToDistribute": 3, "durationSeconds": 120 }
    ]
  }'
```

---

<a id="api-reference"></a>
## 📚 API Reference

### Аутентификация

| Метод | Заголовок | Описание |
|-------|-----------|----------|
| Service Token | `x-service-token: <CORE_API_TOKEN>` | Для межсервисных вызовов |
| Telegram | `Authorization: TMA <initData>` | WebApp аутентификация |
| Demo User | `x-demo-user-id: <userId>` | Только для разработки |

### Основные эндпоинты

#### Аукционы

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/auctions` | Список аукционов |
| `GET` | `/api/auctions/:id` | Детали аукциона |
| `POST` | `/api/auctions` | Создание аукциона |
| `POST` | `/api/auctions/:id/bid` | Размещение ставки |
| `GET` | `/api/auctions/:id/leaderboard` | Топ ставок |
| `GET` | `/api/auctions/:id/replay` | Replay раунда |

#### Баланс

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/balance` | Текущий баланс пользователя |
| `GET` | `/api/balance/history` | История операций |

#### WebSocket события

```javascript
// Подключение
const ws = new WebSocket('ws://localhost:4005/ws');

// События
ws.onmessage = (event) => {
  const { type, payload } = JSON.parse(event.data);
  
  switch (type) {
    case 'bid-placed':
      // Новая ставка
      break;
    case 'outbid':
      // Вашу ставку перебили
      break;
    case 'round-complete':
      // Раунд завершён
      break;
    case 'anti-sniping':
      // Раунд продлён
      break;
  }
};
```

Полная документация API: [`docs/requests.md`](docs/requests.md)

---

<a id="нагрузочное-тестирование"></a>
## ⚡ Нагрузочное тестирование

### Доступные сценарии

```bash
# Полный набор тестов
npm run load:all

# Отдельные сценарии
npm run load:bot        # Симуляция ботов
npm run load:stress     # Стресс-тест ставок
npm run load:anti-sniping # Тест anti-sniping
npm run load:reconcile  # Проверка финансовой корректности

# Интерактивный CLI
npm run load:perf
```

### Что проверяют тесты

| Сценарий | Проверка |
|----------|----------|
| **bot-sim** | Конкурентные ставки от множества ботов |
| **stress-bids** | Высокая нагрузка одновременных запросов |
| **anti-sniping** | Корректность продления раундов |
| **reconcile** | Сходимость балансов после раундов |

### Метрики

После тестов проверьте:

```bash
# Prometheus метрики
curl http://localhost:4001/metrics

# Финансовая сверка
npm run load:reconcile
```

---

<a id="конфигурация"></a>
## ⚙️ Конфигурация

### Core сервисы

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `NODE_ENV` | Окружение | `development` |
| `SERVICE_NAME` | Имя сервиса | - |
| `HTTP_PORT` | Порт | - |
| `LOG_LEVEL` | Уровень логов | `info` |

### Хранилища

| Переменная | Описание |
|------------|----------|
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB` | Имя базы данных |
| `REDIS_URL` | Redis connection string |

### Rate Limits

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `RATE_LIMIT_USER_PER_SECOND` | Лимит на пользователя | `5` |
| `RATE_LIMIT_AUCTION_USER_PER_SECOND` | Лимит на пользователя в аукционе | `3` |
| `RATE_LIMIT_IP_PER_SECOND` | Лимит на IP | `20` |

### Anti-Sniping

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `ANTI_SNIPING_WINDOW_SECONDS` | Окно детекции | `30` |
| `ANTI_SNIPING_EXTENSION_SECONDS` | Продление | `30` |
| `ANTI_SNIPING_MAX_EXTENSIONS` | Максимум продлений | `5` |

### Crypto Gateway

| Переменная | Описание |
|------------|----------|
| `CRYPTO_SUPPORTED_CURRENCIES` | Список валют (USDT) |
| `CRYPTO_WALLET_STRATEGY` | Стратегия: `address_pool`, `memo_tag`, `address_per_user` |
| `CRYPTO_OBSERVER_URL` | URL наблюдателя или `mock` |
| `CRYPTO_SIGNER_URL` | URL подписанта или `mock` |

### Выводы

| Переменная | Описание |
|------------|----------|
| `CRYPTO_WITHDRAWAL_MIN_AMOUNT` | Минимальная сумма |
| `CRYPTO_WITHDRAWAL_MAX_AMOUNT` | Максимальная сумма |
| `CRYPTO_WITHDRAWAL_DAILY_LIMIT` | Дневной лимит |
| `CRYPTO_WITHDRAWAL_COOLDOWN_SECONDS` | Cooldown между выводами |
| `CRYPTO_WITHDRAWAL_ALLOWLIST_REQUIRED` | Требовать allowlist |

---

## 🔒 Безопасность

### Модель аутентификации

```mermaid
flowchart LR
    subgraph "Клиенты"
        WEB[Web App]
        TG[Telegram Mini App]
        SVC[Сервисы]
    end
    
    subgraph "Методы аутентификации"
        JWT[JWT Token]
        TMA[TMA initData]
        SRVTOKEN[Service Token]
    end
    
    subgraph "Валидация"
        HMAC[HMAC-SHA256]
        EXPIRE[Проверка времени]
        IP[IP Allowlist]
    end
    
    WEB --> JWT --> HMAC
    TG --> TMA --> HMAC
    TG --> TMA --> EXPIRE
    SVC --> SRVTOKEN --> IP
```

### Защитные механизмы

- ✅ **CSRF защита** — проверка Origin для небезопасных методов
- ✅ **Rate Limiting** — на пользователя, аукцион и IP
- ✅ **Distributed Locks** — предотвращение race conditions
- ✅ **Idempotency Keys** — защита от дублирования операций
- ✅ **IP Allowlist** — для критичных сервисов (Signer)
- ✅ **KMS интеграция** — опциональное хранение ключей

---

## 📈 Мониторинг

Каждый сервис предоставляет:

```bash
# Liveness probe
GET /health/live

# Readiness probe (включает проверки зависимостей)
GET /health/ready

# Prometheus метрики
GET /metrics
```

### Ключевые метрики

- `http_requests_total` — общее количество запросов
- `http_request_duration_seconds` — латентность
- `bids_total` — количество ставок
- `rounds_finalized_total` — завершённые раунды
- `ledger_operations_total` — операции с балансами

---

## 🤝 Вклад в проект

1. Fork репозитория
2. Создайте feature branch: `git checkout -b feature/amazing-feature`
3. Commit изменений: `git commit -m 'Add amazing feature'`
4. Push в branch: `git push origin feature/amazing-feature`
5. Откройте Pull Request

---

## 📄 Лицензия

MIT License — см. [LICENSE](LICENSE) для деталей.

---

## 📞 Контакты

- **Telegram**: [@your_username](https://t.me/your_username)
- **Email**: your@email.com

---

<div align="center">
  <sub>Built with ❤️ for Telegram Gift Auctions Hackathon</sub>
</div>
