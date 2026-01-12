# Сравнение проектов: TG_GIFTSAUCTION vs crypto-hackathon

## Основные архитектурные различия

### 1. Архитектура сервисов

**TG_GIFTSAUCTION:**
- Монолитный сервис (одна служба)
- Модули внутри: `AuctionEngine`, `BidService`, `PaymentService`
- Все компоненты работают в одном процессе

**crypto-hackathon (наш проект):**
- Микросервисная архитектура (6 отдельных сервисов)
- `auction-engine`, `ledger`, `crypto-gateway`, `bot`, `web`, `workers`
- Каждый сервис работает независимо, может масштабироваться отдельно

### 2. Финансовая модель (Ledger)

**TG_GIFTSAUCTION:**
- Использует поля `Balance` и `LockedBalance` в пользовательских документах
- Обновление баланса через прямые изменения полей
- Транзакции MongoDB для атомарности

**crypto-hackathon:**
- **Ledger-first архитектура** с append-only entries
- Баланс вычисляется из записей ledger (не хранится как поле)
- Типы записей: `deposit_confirmed`, `hold_created`, `hold_released`, `hold_captured`, `withdrawal_*`
- Полная аудиторская трассировка всех финансовых операций
- Встроенные функции reconciliation для проверки корректности

### 3. Кеширование и производительность

**TG_GIFTSAUCTION:**
- Не упоминает Redis явно в описании
- Pull-based engine с короткими интервалами проверки
- Упоминает возможность использования BullMQ/Redis для production

**crypto-hackathon:**
- **Redis активно используется** для:
  - Sorted sets для топ-N ранжирования
  - Распределенные блокировки (distributed locks)
  - Rate limiting (token bucket)
  - Кеширование состояния аукционов
- Разделение: MongoDB = истина (source of truth), Redis = кеш для hot paths

### 4. Конкурентность и блокировки

**TG_GIFTSAUCTION:**
- Оптимистическая блокировка (optimistic locking)
- Используется для обновления состояния аукциона

**crypto-hackathon:**
- **Распределенные блокировки** через Redis
- Идемпотентность через `idempotencyKey` для всех финансовых операций
- Детерминированные state machines для переходов раундов
- Re-entrant операции (можно безопасно повторять)

### 5. Криптовалютная интеграция

**TG_GIFTSAUCTION:**
- Не упоминает криптовалютную интеграцию в описании
- Сфокусирован на аукционной механике

**crypto-hackathon:**
- **Полноценный crypto-gateway сервис:**
  - Deposit watcher с порогами подтверждений
  - Withdrawal state machine (requested → authorized → broadcasted → confirmed/failed)
  - Изолированный signer service для подписи транзакций
  - Withdrawal safety validator (cooldowns, лимиты, anomaly detection)
  - Поддержка нескольких стратегий кошельков (address-per-user, memo/tag)

### 6. Интернационализация

**TG_GIFTSAUCTION:**
- Не упоминает i18n
- Вероятно, только английский язык

**crypto-hackathon:**
- **Встроенная поддержка RU/EN** с первого дня
- i18n слой для всех сообщений, кнопок, ошибок
- Fallback механизмы и определение локали
- Консистентная локализация в боте и web UI

### 7. Безопасность

**TG_GIFTSAUCTION:**
- Базовая безопасность (CSRF, валидация)
- Idempotency tokens для предотвращения двойных платежей

**crypto-hackathon:**
- **Расширенная безопасность:**
  - Многоуровневые rate limits (per IP, per user, per auction)
  - Строгая изоляция секретов (signer service изолирован)
  - Withdrawal safety controls (cooldowns, лимиты, allowlists, anomaly detection)
  - Immutable audit logging
  - Строгое разделение между public API и internal worker API

### 8. Рабочие процессы (Workers)

**TG_GIFTSAUCTION:**
- Pull-based engine в основном процессе
- Финализацию раундов, вероятно, делает основной сервис

**crypto-hackathon:**
- **Отдельный workers сервис:**
  - `auctionRoundScheduler` - планирование раундов
  - `roundFinalizer` - финализация раундов
  - Отделение фоновых задач от критических путей

### 9. Структура проекта

**TG_GIFTSAUCTION:**
```
backend/
  src/
    models/     # Mongoose schemas
    services/   # AuctionEngine, BidService, PaymentService
    scripts/    # Verification scripts
frontend/       # React demo UI
```

**crypto-hackathon:**
```
src/
  services/     # 6 микросервисов
    auction-engine/
    ledger/
    crypto-gateway/
    bot/
    web/
    workers/
  shared/       # Общие библиотеки
    config/
    http/
    i18n/
    storage/
```

### 10. Тестирование

**TG_GIFTSAUCTION:**
- Load testing скрипт (50+ ботов, сотни одновременных ставок)
- Проверка финансовой целостности
- Игровой цикл проверка

**crypto-hackathon:**
- Интеграционные тесты (auctionRoundIntegration, bidPlacement, roundFinalization)
- Unit тесты для компонентов
- Тесты state machine
- Тесты ledger (concurrency, idempotency)

## Ключевые преимущества каждого подхода

### TG_GIFTSAUCTION
✅ Простота развертывания (один сервис)  
✅ Меньше сложности для небольших масштабов  
✅ Быстрая разработка для конкурса

### crypto-hackathon
✅ Масштабируемость (независимое масштабирование сервисов)  
✅ Финансовая корректность (ledger-first архитектура)  
✅ Полная аудиторская трассировка  
✅ Production-ready подход к безопасности  
✅ Готовность к расширению (crypto gateway, i18n)  
✅ Разделение ответственности (SRP)  
✅ Лучшая изоляция критических компонентов

## Выводы

**TG_GIFTSAUCTION** - это хорошо выполненный конкурсный проект с фокусом на аукционную механику и базовую финансовую целостность. Подход монолитного сервиса подходит для демонстрации концепции.

**crypto-hackathon** - это более зрелая архитектура, предназначенная для production-использования с:
- Более строгим подходом к финансовым операциям (ledger-first)
- Готовностью к реальному использованию (crypto gateway, i18n)
- Лучшей архитектурой для масштабирования (микросервисы)
- Более продвинутыми механизмами безопасности

Основное отличие: **crypto-hackathon спроектирован как реальная финансовая инфраструктура**, а не только как конкурсное решение.
