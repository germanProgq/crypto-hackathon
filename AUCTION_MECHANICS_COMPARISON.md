# Сравнение механики аукционов: TG_GIFTSAUCTION vs crypto-hackathon

## Общая архитектура аукционов

### TG_GIFTSAUCTION

**Подход:**
- Монолитный сервис с модулями `AuctionEngine`, `BidService`, `PaymentService`
- Использует MongoDB с транзакциями для финансовых операций
- Оптимистическая блокировка для конкурентности
- Pull-based engine с короткими интервалами проверки

**Механика:**
- Один активный бид на пользователя в рамках аукциона
- Если пользователь делает новую ставку, она "upgrade" существующей
- Если пользователь проигрывает раунд, его ставка **автоматически переносится** в следующий раунд (остается "Active")
- Ставки хранятся в полях `Balance` и `LockedBalance`

### crypto-hackathon

**Подход:**
- Микросервисная архитектура (отдельные сервисы для auction-engine, ledger, workers)
- MongoDB с транзакциями + Redis для кеширования и ранжирования
- Распределенные блокировки через Redis
- Pull-based engine с отдельным workers сервисом

**Механика:**
- Ставки привязаны к конкретному `roundIndex`
- Пользователь должен делать **новую ставку в каждом раунде**
- Ставки хранятся как отдельные документы с привязкой к раунду
- Ledger-first архитектура: баланс вычисляется из записей, а не хранится в полях

---

## Ключевые различия в механике

### 1. Перенос ставок между раундами

**TG_GIFTSAUCTION:**
```typescript
// Концептуально (из описания)
// Пользователь имеет один активный бид на аукцион
// При проигрыше раунда бид остается активным для следующего раунда
user.bid.amount = 100 // остается активным
user.bid.status = "Active" // автоматически в следующем раунде
```

**crypto-hackathon:**
```typescript
// Из bidService.ts и mongoSchemas.ts
// Каждая ставка привязана к конкретному раунду
interface BidDocument {
  auctionId: ObjectId;
  roundIndex: number; // обязательное поле
  userId: string;
  amount: number;
  createdAt: Date;
}

// Пользователь должен делать новую ставку в каждом раунде
// Если проиграл раунд N, должен сделать ставку в раунде N+1
```

**Разница:** 
- TG_GIFTSAUCTION: Автоматический перенос (проигравшие продолжают со своей ставкой)
- crypto-hackathon: Явный перенос (нужно делать новую ставку в каждом раунде)

### 2. Управление ставками пользователя

**TG_GIFTSAUCTION:**
- Один активный бид на аукцион
- Обновление существующей ставки (upgrade)
- Автоматическое участие в следующем раунде при проигрыше

**crypto-hackathon:**
- Множественные ставки (по одной на раунд)
- Каждая ставка - отдельный документ
- При увеличении ставки в том же раунде создается новая запись, старая заменяется в ранжировании
- Для участия в следующем раунде нужна новая ставка

### 3. Финансовая модель

**TG_GIFTSAUCTION:**
```typescript
// Концептуально
user.Balance = 1000
user.LockedBalance = 100 // зарезервировано для ставки
// Балансы хранятся как поля документа
```

**crypto-hackathon:**
```typescript
// Ledger-first архитектура
// Баланс вычисляется из записей ledger
interface LedgerEntryDocument {
  entryType: "hold_created" | "hold_released" | "hold_captured" | ...
  amount: number;
  currency: string;
  userId: string;
  // Баланс = сумма всех записей по типам
}

// available = deposit_confirmed - hold_created + hold_released
// held = hold_created - hold_captured - hold_released
// spent = hold_captured
```

### 4. Ранжирование ставок

**TG_GIFTSAUCTION:**
- По описанию использует ранжирование, но не указано где (вероятно MongoDB)
- Для каждого раунда выбираются топ-N пользователей
- Ранжирование по одной активной ставке на пользователя

**crypto-hackathon:**
```typescript
// Двойное ранжирование: Redis (кеш) + MongoDB (источник истины)
// Из roundFinalizationService.ts

// 1. Redis Sorted Set для быстрого доступа
const rankingKey = `auction:${auctionId}:round:${roundIndex}:ranking`;
// Score = amount, Member = encoded(bidId, createdAt)

// 2. MongoDB aggregation для финального определения
{
  $match: { auctionId, roundIndex },
  $sort: { amount: -1, createdAt: 1, _id: 1 },
  $group: { _id: "$userId", ... }, // одна лучшая ставка на пользователя
  $limit: allocationSize
}

// При финализации: Redis для быстрого доступа, MongoDB для верификации
```

### 5. Anti-sniping механизм

**TG_GIFTSAUCTION:**
- Если ставка размещена в последние 30 секунд раунда → раунд продлевается на 60 секунд
- Обрабатывается атомарно в `BidService`

**crypto-hackathon:**
```typescript
// Из roundStateMachine.ts и auctionStore.ts
interface AntiSnipingConfig {
  triggerWindowSeconds: number; // окно триггера (например, 30)
  extensionSeconds: number;      // продление (например, 60)
  maxExtensions: number;         // максимум продлений (защита от бесконечности)
}

// Алгоритм:
// 1. Проверка попадания в окно триггера
// 2. Проверка лимита продлений
// 3. Обновление effectiveEndAt
// 4. Оптимистическая блокировка для обновления состояния
```

**Разница:**
- TG_GIFTSAUCTION: Фиксированные значения (30/60 секунд)
- crypto-hackathon: Настраиваемые параметры + защита от бесконечных продлений

### 6. Финализация раунда и settlement

**TG_GIFTSAUCTION:**
- Winners: средства "Captured" (удаляются из LockedBalance)
- Non-winners: средства возвращаются (возможно, но не уточнено в описании)
- Settlement происходит после определения победителей

**crypto-hackathon:**
```typescript
// Из roundFinalizationService.ts
async function settleRoundHolds(...) {
  // Winners: capture hold (hold_created -> hold_captured)
  // Non-winners: release hold (hold_created -> hold_released)
  
  // Batch processing для эффективности
  await settleHoldOperations(auction, roundIndex, captureOps);
  await settleHoldOperations(auction, roundIndex, releaseOps);
}

// Re-entrant процесс:
// 1. Определение победителей (idempotent)
// 2. Создание delivery records (idempotent)
// 3. Settlement holds (idempotent через idempotency keys)
// 4. Queue notifications (idempotent)
```

### 7. Tie-breaker (разрешение ничьих)

**TG_GIFTSAUCTION:**
- Не указано явно в описании
- Вероятно, по timestamp

**crypto-hackathon:**
```typescript
// Из roundStateMachine.ts
function compareRankedBids(left: RankedBid, right: RankedBid): number {
  // 1. По сумме (desc)
  if (left.amount !== right.amount) {
    return right.amount - left.amount;
  }
  
  // 2. По времени создания (asc - раньше лучше)
  const timeDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  
  // 3. По bidId (lexicographic)
  // 4. По userId (lexicographic)
  
  // Детерминированный порядок для идентичных ставок
}
```

### 8. Идемпотентность

**TG_GIFTSAUCTION:**
- Использует `referenceId` (например, `BID_LOCK:auctionId_userId`)
- Для предотвращения двойного списания

**crypto-hackathon:**
```typescript
// Идемпотентность на всех уровнях
interface BidPlacementInput {
  idempotencyKey: string; // обязательное поле
}

// Проверка перед операцией
const existing = await bids.findOne({ idempotencyKey });
if (existing && matchesIdempotentBid(existing, input)) {
  return existing; // возврат существующей ставки
}

// Idempotency keys для всех финансовых операций:
// - bid: idempotencyKey
// - hold: `hold:${bidIdempotencyKey}`
// - settlement: `settlement:${auctionId}:${roundIndex}:${action}:${holdId}`
```

### 9. Производительность и конкурентность

**TG_GIFTSAUCTION:**
- Оптимистическая блокировка
- MongoDB транзакции
- Pull-based engine

**crypto-hackathon:**
```typescript
// Многоуровневая оптимизация:

// 1. Redis для hot paths
- Sorted sets для ранжирования (O(log N) для top-K)
- Distributed locks для round-level блокировок
- Cache для состояния раунда (TTL-based invalidation)

// 2. MongoDB транзакции для критических операций
- Атомарная запись ставки + hold
- Верификация перед операцией

// 3. Batch processing для settlement
- Группировка capture/release операций
- Параллельная обработка в батчах

// 4. Rate limiting
- Per-user, per-auction-user, per-IP
- Token bucket алгоритм через Redis

// 5. Разделение критических и фоновых задач
- Bid placement: синхронный, быстрый путь
- Settlement, notifications: асинхронные workers
```

---

## Сравнительная таблица

| Аспект | TG_GIFTSAUCTION | crypto-hackathon |
|--------|----------------|------------------|
| **Перенос ставок** | Автоматический (бид остается активным) | Явный (новая ставка в каждом раунде) |
| **Модель ставок** | Один активный бид на аукцион | Множественные ставки (по раундам) |
| **Финансовая модель** | Поля Balance/LockedBalance | Ledger-first (append-only) |
| **Ранжирование** | MongoDB (предположительно) | Redis (кеш) + MongoDB (источник) |
| **Anti-sniping** | 30/60 секунд (фиксировано) | Настраиваемое + maxExtensions |
| **Tie-breaker** | Не указано | Детерминированный (amount → createdAt → bidId → userId) |
| **Settlement** | Capture для winners | Capture (winners) + Release (non-winners) |
| **Идемпотентность** | referenceId | Многоуровневая (bid, hold, settlement) |
| **Блокировки** | Оптимистическая | Распределенные (Redis) + оптимистическая |
| **Производительность** | Базовая | Оптимизированная (Redis cache, batch processing) |

---

## Выводы

### TG_GIFTSAUCTION
✅ **Проще для пользователя**: автоматический перенос ставок  
✅ **Меньше запросов**: одна ставка на аукцион  
❓ **Менее гибко**: фиксированные параметры anti-sniping  
❓ **Меньше контроля**: автоматическое поведение сложнее отслеживать  

### crypto-hackathon
✅ **Больше контроля**: явное управление ставками по раундам  
✅ **Больше прозрачности**: все ставки видны в истории  
✅ **Более гибко**: настраиваемые параметры  
✅ **Более масштабируемо**: Redis cache, batch processing  
✅ **Более безопасно**: ledger-first, полная аудиторская трассировка  
❓ **Больше действий от пользователя**: нужно делать ставку в каждом раунде  

### Ключевое философское различие

**TG_GIFTSAUCTION** фокусируется на **простоте для пользователя**: "сделал ставку один раз - участвуешь во всех раундах".

**crypto-hackathon** фокусируется на **прозрачности и контроле**: "каждая ставка явная, каждый раунд требует явного действия, вся история видна".

Оба подхода валидны, но они отражают разные философии проектирования:
- **TG_GIFTSAUCTION**: максимизация простоты UX
- **crypto-hackathon**: максимизация прозрачности и аудита
