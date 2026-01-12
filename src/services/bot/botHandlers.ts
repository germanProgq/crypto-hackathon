// Telegram bot command handlers and conversation flows.
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { resolveLocale, t } from "../../shared/i18n/index.js";
import { mongoCollections } from "../../shared/storage/mongoSchemas.js";
const requestTimeoutMs = 8000;
const pollIntervalMs = 2000;
const conversationTtlSeconds = 300;
const maxUserRateLimitPerMinute = 20;

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; language_code?: string };
  text?: string;
  date: number;
};

type TelegramCallbackQuery = {
  id: string;
  from: { id: number; username?: string; language_code?: string };
  message?: TelegramMessage;
  data?: string;
};

type ConversationState = {
  userId: string;
  step: string;
  data: Record<string, unknown>;
  locale: string;
  updatedAt: Date;
};

type BotContext = {
  userId: string;
  chatId: string;
  messageId?: number;
  locale: string;
  state?: ConversationState;
};

export async function registerBotHandlers(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  ensureTelegramConfig(deps);
  const bot = createBotApi(deps);
  let lastUpdateId = 0;
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      lastUpdateId = await bot.processUpdates(lastUpdateId);
    } catch (error) {
      deps.logger.error({ err: error }, "Bot update polling failed");
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  void tick();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

function createBotApi(deps: ServiceDependencies) {
  const token = deps.config.telegram.botToken!;
  const baseUrl = deps.config.telegram.apiBaseUrl.replace(/\/+$/, "");

  async function processUpdates(lastUpdateId: number): Promise<number> {
    const updates = await getUpdates(lastUpdateId);
    let maxId = lastUpdateId;

    for (const update of updates) {
      maxId = Math.max(maxId, update.update_id);
      try {
        await handleUpdate(deps, update);
      } catch (error) {
        deps.logger.error({ err: error, updateId: update.update_id }, "Failed to handle update");
      }
    }

    return maxId + 1;
  }

  async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const url = `${baseUrl}/bot${token}/getUpdates`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 5,
          allowed_updates: ["message", "callback_query"]
        }),
        signal: controller.signal
      });

      const payload = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!response.ok || !payload.ok) {
        throw new Error(`getUpdates failed: ${response.status}`);
      }

      return payload.result ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendMessage(
    chatId: string | number,
    text: string,
    options?: { reply_markup?: unknown; parse_mode?: string }
  ): Promise<void> {
    const url = `${baseUrl}/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...options
        }),
        signal: controller.signal
      });

      const payload = (await response.json()) as { ok: boolean };
      if (!response.ok || !payload.ok) {
        throw new Error(`sendMessage failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const url = `${baseUrl}/bot${token}/answerCallbackQuery`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text
        }),
        signal: controller.signal
      });

      const payload = (await response.json()) as { ok: boolean };
      if (!response.ok || !payload.ok) {
        throw new Error(`answerCallbackQuery failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { processUpdates, sendMessage, answerCallbackQuery };
}

async function handleUpdate(deps: ServiceDependencies, update: TelegramUpdate): Promise<void> {
  if (update.message) {
    await handleMessage(deps, update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(deps, update.callback_query);
  }
}

async function handleMessage(deps: ServiceDependencies, message: TelegramMessage): Promise<void> {
  if (!message.from || !message.text) {
    return;
  }

  const userId = String(message.from.id);
  const chatId = String(message.chat.id);
  const locale = resolveLocale(
    message.from.language_code,
    deps.config.i18n.defaultLocale,
    deps.config.i18n.supportedLocales
  );

  if (!(await checkRateLimit(deps, userId))) {
    const seconds = 60;
    const errorMsg = t("errors.rateLimited", locale, { seconds });
    await sendMessage(deps, chatId, errorMsg);
    return;
  }

  const state = await getConversationState(deps, userId);
  const context: BotContext = {
    userId,
    chatId,
    messageId: message.message_id,
    locale: state?.locale ?? locale,
    state: state ?? undefined
  };

  if (message.text.startsWith("/")) {
    await handleCommand(deps, context, message.text);
  } else {
    await handleConversationMessage(deps, context, message.text);
  }
}

async function handleCallbackQuery(
  deps: ServiceDependencies,
  query: TelegramCallbackQuery
): Promise<void> {
  const userId = String(query.from.id);
  const chatId = query.message ? String(query.message.chat.id) : String(query.from.id);
  const locale = resolveLocale(
    query.from.language_code,
    deps.config.i18n.defaultLocale,
    deps.config.i18n.supportedLocales
  );

  if (!(await checkRateLimit(deps, userId))) {
    await answerCallbackQuery(deps, query.id, t("errors.rateLimited", locale, { seconds: 60 }));
    return;
  }

  const state = await getConversationState(deps, userId);
  const context: BotContext = {
    userId,
    chatId,
    messageId: query.message?.message_id,
    locale: state?.locale ?? locale,
    state: state ?? undefined
  };

  await handleCallbackData(deps, context, query.data ?? "", query.id);
}

async function handleCommand(
  deps: ServiceDependencies,
  context: BotContext,
  command: string
): Promise<void> {
  const cmd = command.split(/\s/)[0]?.toLowerCase() ?? "";

  switch (cmd) {
    case "/start":
      await handleStartCommand(deps, context);
      break;
    case "/balance":
      await handleBalanceCommand(deps, context);
      break;
    case "/deposit":
      await handleDepositCommand(deps, context);
      break;
    case "/auctions":
      await handleAuctionsCommand(deps, context);
      break;
    case "/withdraw":
      await handleWithdrawCommand(deps, context);
      break;
    case "/help":
      await handleHelpCommand(deps, context);
      break;
    case "/language":
      await handleLanguageCommand(deps, context);
      break;
    default:
      await sendMessage(deps, context.chatId, t("bot.error.tryAgain", context.locale));
  }
}

async function handleStartCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const welcome = t("bot.start.welcome", context.locale);
  const instructions = t("bot.start.instructions", context.locale);
  const keyboard = buildMainMenu(context.locale);

  await sendMessage(deps, context.chatId, `${welcome}\n\n${instructions}`, {
    reply_markup: keyboard
  });
}

async function handleBalanceCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const ledgerEntries = deps.mongo.db.collection(mongoCollections.ledgerEntries);
  const entries = await ledgerEntries
    .find({ userId: context.userId })
    .sort({ createdAt: 1 })
    .toArray();

  let available = 0;
  let held = 0;

  for (const entry of entries) {
    const amount = entry.amount ?? 0;
    if (entry.type === "deposit_confirmed") {
      available += amount;
    } else if (entry.type === "hold_created") {
      available -= amount;
      held += amount;
    } else if (entry.type === "hold_released") {
      available += amount;
      held -= amount;
    } else if (entry.type === "hold_captured") {
      held -= amount;
    } else if (entry.type === "withdrawal_broadcasted") {
      available -= amount;
    }
  }

  const currency = "TON";
  const total = available + held;

  if (total <= 0) {
    await sendMessage(deps, context.chatId, t("bot.balance.noBalance", context.locale));
    return;
  }

  const title = t("bot.balance.title", context.locale);
  const availableText = t("bot.balance.available", context.locale, {
    amount: formatAmount(available),
    currency
  });
  const heldText = t("bot.balance.held", context.locale, {
    amount: formatAmount(held),
    currency
  });
  const totalText = t("bot.balance.total", context.locale, {
    amount: formatAmount(total),
    currency
  });

  await sendMessage(
    deps,
    context.chatId,
    `${title}\n\n${availableText}\n${heldText}\n${totalText}`
  );
}

async function handleDepositCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const currency = "TON";
  const confirmations = 1;
  const address = `deposit-address-${context.userId}`;
  const memo = `MEMO${context.userId}`;

  const title = t("bot.deposit.title", context.locale);
  const instructions = t("bot.deposit.instructions", context.locale, { currency });
  const addressText = t("bot.deposit.address", context.locale, { address });
  const memoText = t("bot.deposit.memo", context.locale, { memo });
  const memoRequired = t("bot.deposit.memoRequired", context.locale);
  const confirmationsText = t("bot.deposit.confirmations", context.locale, { confirmations });
  const warning = t("bot.deposit.warning", context.locale, { currency });

  await sendMessage(
    deps,
    context.chatId,
    `${title}\n\n${instructions}\n\n${addressText}\n${memoText}\n\n${memoRequired}\n${confirmationsText}\n\n${warning}`
  );
}

async function handleAuctionsCommand(
  deps: ServiceDependencies,
  context: BotContext
): Promise<void> {
  await clearConversationState(deps, context.userId);

  const auctions = deps.mongo.db.collection(mongoCollections.auctions);
  const activeAuctions = await auctions
    .find({ status: "active" })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  if (activeAuctions.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.auctions.noActive", context.locale));
    return;
  }

  const title = t("bot.auctions.title", context.locale);
  const buttons = activeAuctions.map((auction) => {
    const name = auction.name ?? "Unnamed";
    const currentRound = (auction.currentRoundIndex ?? 0) + 1;
    const totalRounds = auction.rounds?.length ?? 0;
    const label = t("bot.auctions.item", context.locale, {
      name,
      round: currentRound,
      totalRounds
    });
    return [
      {
        text: label,
        callback_data: `auction:${auction._id.toHexString()}`
      }
    ];
  });

  await sendMessage(deps, context.chatId, title, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleWithdrawCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  const ledgerEntries = deps.mongo.db.collection(mongoCollections.ledgerEntries);
  const entries = await ledgerEntries
    .find({ userId: context.userId })
    .sort({ createdAt: 1 })
    .toArray();

  let available = 0;

  for (const entry of entries) {
    const amount = entry.amount ?? 0;
    if (entry.type === "deposit_confirmed") {
      available += amount;
    } else if (entry.type === "hold_created") {
      available -= amount;
    } else if (entry.type === "hold_released") {
      available += amount;
    } else if (entry.type === "withdrawal_broadcasted") {
      available -= amount;
    }
  }

  const currency = "TON";

  if (available <= 0) {
    await sendMessage(deps, context.chatId, t("bot.withdraw.noBalance", context.locale));
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "withdraw:amount",
    data: { availableBalance: available, currency },
    locale: context.locale,
    updatedAt: new Date()
  });

  const title = t("bot.withdraw.title", context.locale);
  const availableText = t("bot.withdraw.availableBalance", context.locale, {
    amount: formatAmount(available),
    currency
  });
  const prompt = t("bot.withdraw.promptAmount", context.locale, { currency });

  await sendMessage(deps, context.chatId, `${title}\n\n${availableText}\n\n${prompt}`);
}

async function handleHelpCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const title = t("bot.help.title", context.locale);
  const content = t("bot.help.content", context.locale);
  const support = t("bot.help.support", context.locale);

  await sendMessage(deps, context.chatId, `${title}\n\n${content}\n\n${support}`);
}

async function handleLanguageCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const title = t("bot.language.title", context.locale);
  const keyboard = {
    inline_keyboard: [
      [{ text: t("bot.language.en", context.locale), callback_data: "lang:en" }],
      [{ text: t("bot.language.ru", context.locale), callback_data: "lang:ru" }]
    ]
  };

  await sendMessage(deps, context.chatId, title, { reply_markup: keyboard });
}

async function handleConversationMessage(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  if (!context.state) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const step = context.state.step;

  if (step === "withdraw:amount") {
    await handleWithdrawAmountInput(deps, context, text);
  } else if (step === "withdraw:address") {
    await handleWithdrawAddressInput(deps, context, text);
  } else if (step === "bid:amount") {
    await handleBidAmountInput(deps, context, text);
  } else {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
  }
}

async function handleWithdrawAmountInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const amount = parseFloat(text);
  const availableBalance = (context.state?.data.availableBalance as number) ?? 0;
  const currency = (context.state?.data.currency as string) ?? "TON";

  if (!Number.isFinite(amount) || amount <= 0) {
    await sendMessage(deps, context.chatId, t("bot.withdraw.invalidAmount", context.locale));
    return;
  }

  if (amount > availableBalance) {
    const errorMsg = t("bot.withdraw.amountTooHigh", context.locale, {
      max: formatAmount(availableBalance)
    });
    await sendMessage(deps, context.chatId, errorMsg);
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "withdraw:address",
    data: { ...context.state!.data, amount, currency },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.withdraw.promptAddress", context.locale, { currency });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleWithdrawAddressInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const address = text.trim();
  const amount = (context.state?.data.amount as number) ?? 0;
  const currency = (context.state?.data.currency as string) ?? "TON";

  if (address.length < 10) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.withdraw.invalidAddress", context.locale, { currency })
    );
    return;
  }

  await clearConversationState(deps, context.userId);

  const confirmation = t("bot.withdraw.confirmation", context.locale, {
    amount: formatAmount(amount),
    currency,
    address
  });
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: t("bot.withdraw.confirmYes", context.locale),
          callback_data: `withdraw:confirm:${amount}:${address}`
        }
      ],
      [
        {
          text: t("bot.withdraw.confirmNo", context.locale),
          callback_data: "withdraw:cancel"
        }
      ]
    ]
  };

  await sendMessage(deps, context.chatId, confirmation, { reply_markup: keyboard });
}

async function handleBidAmountInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const amount = parseFloat(text);
  const auctionId = context.state?.data.auctionId as string;
  const currency = context.state?.data.currency as string;

  if (!Number.isFinite(amount) || amount <= 0) {
    await sendMessage(deps, context.chatId, t("bot.bid.invalidAmount", context.locale));
    return;
  }

  await clearConversationState(deps, context.userId);

  const confirmation = t("bot.bid.confirmation", context.locale, {
    amount: formatAmount(amount),
    currency
  });
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: t("bot.bid.confirmYes", context.locale),
          callback_data: `bid:confirm:${auctionId}:${amount}`
        }
      ],
      [
        {
          text: t("bot.bid.confirmNo", context.locale),
          callback_data: `auction:${auctionId}`
        }
      ]
    ]
  };

  await sendMessage(deps, context.chatId, confirmation, { reply_markup: keyboard });
}

async function handleCallbackData(
  deps: ServiceDependencies,
  context: BotContext,
  data: string,
  queryId: string
): Promise<void> {
  const parts = data.split(":");

  if (parts[0] === "auction") {
    await handleAuctionDetails(deps, context, parts[1] ?? "");
  } else if (parts[0] === "bid") {
    if (parts[1] === "start") {
      await handleStartBid(deps, context, parts[2] ?? "");
    } else if (parts[1] === "confirm") {
      await handleConfirmBid(deps, context, parts[2] ?? "", parseFloat(parts[3] ?? "0"));
    }
  } else if (parts[0] === "withdraw") {
    if (parts[1] === "confirm") {
      await handleConfirmWithdraw(deps, context, parseFloat(parts[2] ?? "0"), parts[3] ?? "");
    } else if (parts[1] === "cancel") {
      await answerCallbackQuery(deps, queryId, t("bot.withdraw.cancel", context.locale));
      await clearConversationState(deps, context.userId);
    }
  } else if (parts[0] === "lang") {
    await handleLanguageChange(deps, context, parts[1] ?? "en");
  }

  await answerCallbackQuery(deps, queryId);
}

async function handleAuctionDetails(
  deps: ServiceDependencies,
  context: BotContext,
  auctionIdStr: string
): Promise<void> {
  const auctionId = ObjectId.createFromHexString(auctionIdStr);
  const auctions = deps.mongo.db.collection(mongoCollections.auctions);
  const auction = await auctions.findOne({ _id: auctionId });

  if (!auction || auction.status !== "active") {
    await sendMessage(deps, context.chatId, t("errors.notFound", context.locale));
    return;
  }

  const bids = deps.mongo.db.collection(mongoCollections.bids);
  const userBid = await bids.findOne({ auctionId, userId: context.userId, active: true });

  const name = auction.name ?? "Unnamed";
  const description = auction.description ?? "";
  const currency = auction.currency ?? "TON";
  const currentRound = (auction.currentRoundIndex ?? 0) + 1;
  const totalRounds = auction.rounds?.length ?? 0;
  const status = auction.status ?? "unknown";
  const allocation = auction.rounds?.[auction.currentRoundIndex ?? 0]?.allocationSize ?? 0;

  const title = t("bot.auction.details.title", context.locale);
  const nameText = t("bot.auction.details.name", context.locale, { name });
  const currencyText = t("bot.auction.details.currency", context.locale, { currency });
  const roundText = t("bot.auction.details.currentRound", context.locale, {
    round: currentRound,
    totalRounds
  });
  const statusText = t("bot.auction.details.status", context.locale, { status });
  const allocationText = t("bot.auction.details.allocation", context.locale, { allocation });

  let bidText = t("bot.auction.details.noBid", context.locale);
  if (userBid && userBid.amount) {
    bidText = t("bot.auction.details.yourBid", context.locale, {
      amount: formatAmount(userBid.amount),
      currency
    });
  }

  const message = `${title}\n\n${nameText}\n${description}\n\n${currencyText}\n${roundText}\n${statusText}\n${allocationText}\n\n${bidText}`;

  const buttons = [];
  if (userBid) {
    buttons.push([
      {
        text: t("bot.auction.updateBid", context.locale),
        callback_data: `bid:start:${auctionIdStr}`
      }
    ]);
  } else {
    buttons.push([
      {
        text: t("bot.auction.placeBid", context.locale),
        callback_data: `bid:start:${auctionIdStr}`
      }
    ]);
  }

  buttons.push([
    {
      text: t("bot.auction.backToList", context.locale),
      callback_data: "auctions:list"
    }
  ]);

  await sendMessage(deps, context.chatId, message, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleStartBid(
  deps: ServiceDependencies,
  context: BotContext,
  auctionIdStr: string
): Promise<void> {
  const auctionId = ObjectId.createFromHexString(auctionIdStr);
  const auctions = deps.mongo.db.collection(mongoCollections.auctions);
  const auction = await auctions.findOne({ _id: auctionId });

  if (!auction || auction.status !== "active") {
    await sendMessage(deps, context.chatId, t("errors.auctionNotActive", context.locale));
    return;
  }

  const currency = auction.currency ?? "TON";

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "bid:amount",
    data: { auctionId: auctionIdStr, currency },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.bid.prompt", context.locale, { currency });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleConfirmBid(
  deps: ServiceDependencies,
  context: BotContext,
  auctionIdStr: string,
  amount: number
): Promise<void> {
  const processingMsg = t("bot.bid.processing", context.locale);
  await sendMessage(deps, context.chatId, processingMsg);

  const auctionId = ObjectId.createFromHexString(auctionIdStr);
  const auctions = deps.mongo.db.collection(mongoCollections.auctions);
  const auction = await auctions.findOne({ _id: auctionId });

  if (!auction || auction.status !== "active") {
    await sendMessage(deps, context.chatId, t("errors.auctionNotActive", context.locale));
    return;
  }

  const currency = auction.currency ?? "TON";
  const success = t("bot.bid.success", context.locale);
  const successAmount = t("bot.bid.successAmount", context.locale, {
    amount: formatAmount(amount),
    currency
  });
  const successHeld = t("bot.bid.successHeld", context.locale, {
    held: formatAmount(amount),
    currency
  });

  await sendMessage(deps, context.chatId, `${success}\n\n${successAmount}\n${successHeld}`);
}

async function handleConfirmWithdraw(
  deps: ServiceDependencies,
  context: BotContext,
  amount: number,
  _address: string
): Promise<void> {
  const processingMsg = t("bot.withdraw.processing", context.locale);
  await sendMessage(deps, context.chatId, processingMsg);

  const currency = "TON";
  const success = t("bot.withdraw.success", context.locale);
  const successMessage = t("bot.withdraw.successMessage", context.locale, {
    amount: formatAmount(amount),
    currency
  });

  await sendMessage(deps, context.chatId, `${success}\n\n${successMessage}`);
}

async function handleLanguageChange(
  deps: ServiceDependencies,
  context: BotContext,
  newLocale: string
): Promise<void> {
  await clearConversationState(deps, context.userId);

  const message = t("bot.language.changed", newLocale);
  await sendMessage(deps, context.chatId, message);
}

function buildMainMenu(locale: string) {
  return {
    keyboard: [
      [{ text: t("bot.menu.balance", locale) }, { text: t("bot.menu.deposit", locale) }],
      [{ text: t("bot.menu.auctions", locale) }, { text: t("bot.menu.withdraw", locale) }],
      [{ text: t("bot.menu.help", locale) }, { text: t("bot.menu.language", locale) }]
    ],
    resize_keyboard: true
  };
}

async function getConversationState(
  deps: ServiceDependencies,
  userId: string
): Promise<ConversationState | null> {
  const key = `conversation:${userId}`;
  const data = await deps.redis.get(key);
  if (!data) {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as ConversationState;
    return {
      ...parsed,
      updatedAt: new Date(parsed.updatedAt)
    };
  } catch {
    return null;
  }
}

async function setConversationState(
  deps: ServiceDependencies,
  userId: string,
  state: ConversationState
): Promise<void> {
  const key = `conversation:${userId}`;
  await deps.redis.setex(key, conversationTtlSeconds, JSON.stringify(state));
}

async function clearConversationState(deps: ServiceDependencies, userId: string): Promise<void> {
  const key = `conversation:${userId}`;
  await deps.redis.del(key);
}

async function checkRateLimit(deps: ServiceDependencies, userId: string): Promise<boolean> {
  const key = `ratelimit:bot:${userId}`;
  const current = await deps.redis.incr(key);

  if (current === 1) {
    await deps.redis.expire(key, 60);
  }

  return current <= maxUserRateLimitPerMinute;
}

async function sendMessage(
  deps: ServiceDependencies,
  chatId: string,
  text: string,
  options?: { reply_markup?: unknown; parse_mode?: string }
): Promise<void> {
  const bot = createBotApi(deps);
  await bot.sendMessage(chatId, text, options);
}

async function answerCallbackQuery(
  deps: ServiceDependencies,
  queryId: string,
  text?: string
): Promise<void> {
  const bot = createBotApi(deps);
  await bot.answerCallbackQuery(queryId, text);
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8
  }).format(amount);
}

function ensureTelegramConfig(deps: ServiceDependencies): void {
  if (!deps.config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for bot service.");
  }
}
