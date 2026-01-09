// English localization catalog.
const enCatalog = {
  "common.ok": "OK",
  "common.cancel": "Cancel",
  "common.loading": "Loading",
  "errors.unknown": "Unexpected error",
  "errors.validation": "Invalid input",
  "health.live": "Service is live",
  "health.ready": "Service is ready",
  "service.started": "Service started",
  "service.stopped": "Service stopped",
  "service.dependencyDown": "Dependency unavailable",
  "bot.roundResult.winner":
    "Round {{round}} results for auction {{auctionId}}: you placed rank {{rank}} with {{amount}} {{currency}}.",
  "bot.roundResult.delivery": "Delivery reference: {{deliveryRef}}.",
  "bot.roundResult.nonWinner":
    "Round {{round}} results for auction {{auctionId}}: you did not win. Your bid of {{amount}} {{currency}} was released."
} as const;

export default enCatalog;
