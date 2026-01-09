// Russian localization catalog.
const ruCatalog = {
  "common.ok": "OK",
  "common.cancel": "Отмена",
  "common.loading": "Загрузка",
  "errors.unknown": "Неожиданная ошибка",
  "errors.validation": "Некорректные данные",
  "health.live": "Сервис работает",
  "health.ready": "Сервис готов",
  "service.started": "Сервис запущен",
  "service.stopped": "Сервис остановлен",
  "service.dependencyDown": "Зависимость недоступна",
  "bot.roundResult.winner":
    "Итоги раунда {{round}} для аукциона {{auctionId}}: ваше место {{rank}}, ставка {{amount}} {{currency}}.",
  "bot.roundResult.delivery": "Ссылка на доставку: {{deliveryRef}}.",
  "bot.roundResult.nonWinner":
    "Итоги раунда {{round}} для аукциона {{auctionId}}: вы не выиграли. Ваша ставка {{amount}} {{currency}} разблокирована."
} as const;

export default ruCatalog;
