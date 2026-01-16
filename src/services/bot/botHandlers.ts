// Telegram bot command handlers and conversation flows.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { ServiceDependencies } from "../../shared/service.js";
import { resolveLocale, t } from "../../shared/i18n/index.js";
import {
  mongoCollections,
  type AuctionDocument,
  type AuctionStatus,
  type BidDocument
} from "../../shared/storage/mongoSchemas.js";
import {
  invalidateActiveAuctionListCache,
  readAuctionSnapshotFromRedis,
  readRoundStateFromRedis,
  type AuctionSnapshotCache,
  type RoundStateCache
} from "../auction-engine/auctionCache.js";
import { buildRankingKey } from "../auction-engine/auctionKeys.js";
import { parseRankingMember } from "../auction-engine/bidRanking.js";
import { BidError, createBidService } from "../auction-engine/bidService.js";
import { createAuctionRepository } from "../auction-engine/auctionStore.js";
import { createCryptoGatewayService, CryptoGatewayError } from "../crypto-gateway/cryptoGatewayService.js";
import { createLedgerRepository, LedgerError } from "../ledger/ledgerStore.js";
const requestTimeoutMs = 8000;
const pollIntervalMs = 2000;
const conversationTtlSeconds = 300;
const maxUserRateLimitPerMinute = 20;
const createDefaults = {
  rounds: 3,
  allocationSize: 5,
  roundDurationSeconds: 300,
  startOffsetSeconds: 0,
  antiSniping: {
    triggerWindowSeconds: 10,
    extensionSeconds: 15,
    maxExtensions: 3
  }
};

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

  const trimmedText = message.text.trim();
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

  if (trimmedText.startsWith("/")) {
    await handleCommand(deps, context, trimmedText);
    return;
  }

  const menuCommand = resolveMenuCommand(trimmedText, deps.config.i18n.supportedLocales);
  if (menuCommand) {
    await handleCommand(deps, context, menuCommand);
    return;
  }

  await handleConversationMessage(deps, context, message.text);
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
    case "/create":
      await handleCreateCommand(deps, context, command);
      break;
    case "/withdraw":
      await handleWithdrawCommand(deps, context);
      break;
    case "/help":
      await handleHelpCommand(deps, context);
      break;
    case "/settings":
      await handleSettingsCommand(deps, context);
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

  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays
  });
  const currency = resolveDefaultCurrency(deps);
  const balance = await ledger.getBalance(context.userId, currency);
  const available = balance.available;
  const held = balance.held;
  const total = balance.current;
  const keyboard = buildBalanceActionsKeyboard(context.locale, available > 0);

  if (total <= 0) {
    await sendMessage(deps, context.chatId, t("bot.balance.noBalance", context.locale), {
      reply_markup: keyboard
    });
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
    `${title}\n\n${availableText}\n${heldText}\n${totalText}`,
    { reply_markup: keyboard }
  );
}

async function handleDepositCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  await clearConversationState(deps, context.userId);

  const currency = resolveDefaultCurrency(deps);
  const confirmations = deps.config.crypto.deposit.confirmations;
  const cryptoGateway = createCryptoGatewayService(deps);

  try {
    const destination = await cryptoGateway.getDepositDestination(context.userId, currency);
    const title = t("bot.deposit.title", context.locale);
    const instructions = t("bot.deposit.instructions", context.locale, {
      currency: destination.currency
    });
    const addressText = t("bot.deposit.address", context.locale, {
      address: destination.address
    });
    const confirmationsText = t("bot.deposit.confirmations", context.locale, { confirmations });
    const warning = t("bot.deposit.warning", context.locale, { currency: destination.currency });

    const lines = [title, "", instructions, "", addressText];
    if (destination.memo) {
      const memoText = t("bot.deposit.memo", context.locale, { memo: destination.memo });
      const memoRequired = t("bot.deposit.memoRequired", context.locale);
      lines.push(memoText, "", memoRequired);
    }
    lines.push(confirmationsText, "", warning);

    await sendMessage(deps, context.chatId, lines.join("\n"));
  } catch (error) {
    const message = t("bot.error.tryAgain", context.locale);
    await sendMessage(deps, context.chatId, message);
  }
}

async function handleAuctionsCommand(
  deps: ServiceDependencies,
  context: BotContext
): Promise<void> {
  await clearConversationState(deps, context.userId);

  const auctions = deps.mongo.db.collection(mongoCollections.auctions);
  const activeAuctions = await auctions
    .find({ status: { $in: ["draft", "live"] } })
    .sort({ startsAt: 1 })
    .limit(10)
    .toArray();

  if (activeAuctions.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.auctions.noActive", context.locale));
    return;
  }

  const title = t("bot.auctions.title", context.locale);
  const buttons = activeAuctions.map((auction) => {
    const name = auction.title ?? "Unnamed";
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

async function handleCreateCommand(
  deps: ServiceDependencies,
  context: BotContext,
  command: string
): Promise<void> {
  await clearConversationState(deps, context.userId);

  const parts = command.trim().split(/\s+/);
  const titleFromCommand = parts.slice(1).join(" ").trim();

  if (titleFromCommand.length > 0) {
    await setConversationState(deps, context.userId, {
      userId: context.userId,
      step: "create:description",
      data: { title: titleFromCommand },
      locale: context.locale,
      updatedAt: new Date()
    });

    const prompt = t("bot.create.descriptionPrompt", context.locale);
    await sendMessage(deps, context.chatId, prompt);
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:title",
    data: {},
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.titlePrompt", context.locale);
  await sendMessage(deps, context.chatId, prompt);
}

async function handleWithdrawCommand(deps: ServiceDependencies, context: BotContext): Promise<void> {
  const ledger = createLedgerRepository(deps.mongo, {
    retentionDays: deps.config.dataRetention.ledgerDays
  });
  const currency = resolveDefaultCurrency(deps);
  const balance = await ledger.getBalance(context.userId, currency);
  const available = balance.available;

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

async function handleSettingsCommand(
  deps: ServiceDependencies,
  context: BotContext
): Promise<void> {
  await clearConversationState(deps, context.userId);

  const title = t("bot.settings.title", context.locale);
  const keyboard = {
    inline_keyboard: [
      [{ text: t("bot.settings.help", context.locale), callback_data: "settings:help" }],
      [{ text: t("bot.settings.language", context.locale), callback_data: "settings:language" }]
    ]
  };

  await sendMessage(deps, context.chatId, title, { reply_markup: keyboard });
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
  } else if (step === "withdraw:memo") {
    await handleWithdrawMemoInput(deps, context, text);
  } else if (step === "create:title") {
    await handleCreateTitleInput(deps, context, text);
  } else if (step === "create:description") {
    await handleCreateDescriptionInput(deps, context, text);
  } else if (step === "create:currency") {
    await handleCreateCurrencyInput(deps, context, text);
  } else if (step === "create:rounds") {
    await handleCreateRoundsInput(deps, context, text);
  } else if (step === "create:allocation") {
    await handleCreateAllocationInput(deps, context, text);
  } else if (step === "create:duration") {
    await handleCreateDurationInput(deps, context, text);
  } else if (step === "create:startOffset") {
    await handleCreateStartOffsetInput(deps, context, text);
  } else if (step === "create:antiSniping") {
    await handleCreateAntiSnipingInput(deps, context, text);
  } else if (step === "create:antiSniping:trigger") {
    await handleCreateTriggerWindowInput(deps, context, text);
  } else if (step === "create:antiSniping:extension") {
    await handleCreateExtensionInput(deps, context, text);
  } else if (step === "create:antiSniping:maxExtensions") {
    await handleCreateMaxExtensionsInput(deps, context, text);
  } else if (step === "bid:amount") {
    await handleBidAmountInput(deps, context, text);
  } else {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
  }
}

async function handleCreateTitleInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const title = text.trim();
  if (title.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.create.invalidTitle", context.locale));
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:description",
    data: { title },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.descriptionPrompt", context.locale);
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateDescriptionInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const title = (context.state?.data.title as string | undefined)?.trim() ?? "";
  if (title.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const description = normalizeOptionalInput(text);
  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:currency",
    data: { title, description },
    locale: context.locale,
    updatedAt: new Date()
  });

  const defaultCurrency = resolveDefaultCurrency(deps);
  const supported = deps.config.crypto.supportedCurrencies;
  const prompt = t("bot.create.currencyPrompt", context.locale, {
    currency: defaultCurrency,
    supported: supported.join(", ")
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateCurrencyInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const title = (context.state?.data.title as string | undefined)?.trim() ?? "";
  if (title.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const description = (context.state?.data.description as string | undefined) ?? undefined;
  const supported = deps.config.crypto.supportedCurrencies;
  const defaultCurrency = resolveDefaultCurrency(deps);
  const input = parseOptionalToken(text);
  const currency = input ? input.toUpperCase() : defaultCurrency;

  if (!supported.includes(currency)) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.invalidCurrency", context.locale, {
        supported: supported.join(", ")
      })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:rounds",
    data: { title, description, currency },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.roundsPrompt", context.locale, {
    value: createDefaults.rounds
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateRoundsInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.rounds);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 1 || value > 20) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 1, max: 20 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:allocation",
    data: { ...draft, rounds: value },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.allocationPrompt", context.locale, {
    value: createDefaults.allocationSize
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateAllocationInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.allocationSize);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 1 || value > 500) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 1, max: 500 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:duration",
    data: { ...draft, allocationSize: value },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.durationPrompt", context.locale, {
    value: createDefaults.roundDurationSeconds
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateDurationInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.roundDurationSeconds);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 30 || value > 7200) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 30, max: 7200 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:startOffset",
    data: { ...draft, roundDurationSeconds: value },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.startOffsetPrompt", context.locale, {
    value: createDefaults.startOffsetSeconds
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateStartOffsetInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.startOffsetSeconds);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 0 || value > 86400) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 0, max: 86400 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:antiSniping",
    data: { ...draft, startOffsetSeconds: value },
    locale: context.locale,
    updatedAt: new Date()
  });

  await promptAntiSnipingChoice(deps, context);
}

async function handleCreateAntiSnipingInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const choice = parseYesNo(text);
  if (choice === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidYesNo", context.locale));
    await promptAntiSnipingChoice(deps, context);
    return;
  }

  await handleCreateAntiSnipingSelection(deps, context, choice);
}

async function handleCreateAntiSnipingSelection(
  deps: ServiceDependencies,
  context: BotContext,
  enabled: boolean
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  if (!enabled) {
    await finalizeCreateAuction(deps, context, {
      ...draft,
      antiSniping: { ...createDefaults.antiSniping }
    });
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:antiSniping:trigger",
    data: { ...draft },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.triggerWindowPrompt", context.locale, {
    value: createDefaults.antiSniping.triggerWindowSeconds
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateTriggerWindowInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  if (!draft) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.antiSniping.triggerWindowSeconds);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 0 || value > 600) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 0, max: 600 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:antiSniping:extension",
    data: { ...draft, antiSniping: { triggerWindowSeconds: value } },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.extensionPrompt", context.locale, {
    value: createDefaults.antiSniping.extensionSeconds
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateExtensionInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  const antiSniping = (draft?.antiSniping as Record<string, number> | undefined) ?? {};
  const triggerWindowSeconds = antiSniping.triggerWindowSeconds;

  if (!draft || triggerWindowSeconds === undefined) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.antiSniping.extensionSeconds);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 0 || value > 600) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 0, max: 600 })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "create:antiSniping:maxExtensions",
    data: {
      ...draft,
      antiSniping: { triggerWindowSeconds, extensionSeconds: value }
    },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.create.maxExtensionsPrompt", context.locale, {
    value: createDefaults.antiSniping.maxExtensions
  });
  await sendMessage(deps, context.chatId, prompt);
}

async function handleCreateMaxExtensionsInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const draft = getCreateDraft(context);
  const antiSniping = (draft?.antiSniping as Record<string, number> | undefined) ?? {};
  const triggerWindowSeconds = antiSniping.triggerWindowSeconds;
  const extensionSeconds = antiSniping.extensionSeconds;

  if (!draft || triggerWindowSeconds === undefined || extensionSeconds === undefined) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const value = parseOptionalInteger(text, createDefaults.antiSniping.maxExtensions);
  if (value === null) {
    await sendMessage(deps, context.chatId, t("bot.create.error.invalidNumber", context.locale));
    return;
  }

  if (value < 0 || value > 20) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.create.error.range", context.locale, { min: 0, max: 20 })
    );
    return;
  }

  await finalizeCreateAuction(deps, context, {
    ...draft,
    antiSniping: { triggerWindowSeconds, extensionSeconds, maxExtensions: value }
  });
}

async function promptAntiSnipingChoice(
  deps: ServiceDependencies,
  context: BotContext
): Promise<void> {
  const prompt = t("bot.create.antiSnipingPrompt", context.locale);
  const keyboard = {
    inline_keyboard: [
      [
        { text: t("common.yes", context.locale), callback_data: "create:antisniping:yes" },
        { text: t("common.no", context.locale), callback_data: "create:antisniping:no" }
      ]
    ]
  };

  await sendMessage(deps, context.chatId, prompt, { reply_markup: keyboard });
}

function getCreateDraft(context: BotContext): Record<string, unknown> | null {
  const data = context.state?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const title = (data as Record<string, unknown>).title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return null;
  }
  return data as Record<string, unknown>;
}

function parseOptionalInteger(text: string, fallback: number): number | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "skip" || normalized === "default" || normalized === "-") {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function parseOptionalToken(text: string): string | null {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "skip" || normalized === "default" || normalized === "-") {
    return null;
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parseYesNo(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["no", "n", "false", "0"].includes(normalized)) {
    return false;
  }
  return null;
}

async function finalizeCreateAuction(
  deps: ServiceDependencies,
  context: BotContext,
  draft: Record<string, unknown>
): Promise<void> {
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  if (title.length === 0) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const description = typeof draft.description === "string" ? draft.description : undefined;
  const currency =
    typeof draft.currency === "string" ? draft.currency : resolveDefaultCurrency(deps);
  const roundsCount =
    typeof draft.rounds === "number" ? draft.rounds : createDefaults.rounds;
  const allocationSize =
    typeof draft.allocationSize === "number"
      ? draft.allocationSize
      : createDefaults.allocationSize;
  const roundDurationSeconds =
    typeof draft.roundDurationSeconds === "number"
      ? draft.roundDurationSeconds
      : createDefaults.roundDurationSeconds;
  const startOffsetSeconds =
    typeof draft.startOffsetSeconds === "number"
      ? draft.startOffsetSeconds
      : createDefaults.startOffsetSeconds;
  const antiSniping =
    typeof draft.antiSniping === "object" && draft.antiSniping
      ? (draft.antiSniping as {
          triggerWindowSeconds: number;
          extensionSeconds: number;
          maxExtensions: number;
        })
      : { ...createDefaults.antiSniping };

  const now = new Date();
  const startAt = new Date(now.getTime() + startOffsetSeconds * 1000);
  const rounds = Array.from({ length: roundsCount }).map((_, index) => {
    const roundStart = new Date(startAt.getTime() + index * roundDurationSeconds * 1000);
    const roundEnd = new Date(roundStart.getTime() + roundDurationSeconds * 1000);
    return {
      index,
      allocationSize,
      startAt: roundStart,
      endAt: roundEnd,
      antiSniping: {
        triggerWindowSeconds: antiSniping.triggerWindowSeconds,
        extensionSeconds: antiSniping.extensionSeconds,
        maxExtensions: antiSniping.maxExtensions
      }
    };
  });
  const firstRound = rounds[0] ?? null;
  const endsAt = rounds[rounds.length - 1]?.endAt ?? startAt;
  const status: AuctionStatus = startAt.getTime() <= now.getTime() ? "live" : "draft";
  const auction: AuctionDocument = {
    title,
    status,
    currency,
    startsAt: startAt,
    endsAt,
    rounds,
    currentRoundIndex: firstRound?.index ?? null,
    roundStatus: firstRound ? "scheduled" : null,
    roundEffectiveEndAt: firstRound?.endAt ?? null,
    roundLastBidAt: null,
    lastBidAmount: null,
    createdAt: now,
    updatedAt: now
  };
  if (description && description.trim().length > 0) {
    auction.description = description.trim();
  }

  try {
    const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
    const inserted = await auctions.insertOne(auction);
    const stored = await auctions.findOne({ _id: inserted.insertedId });
    if (stored) {
      const auctionRepository = createAuctionRepository(deps.mongo);
      await auctionRepository.ensureRoundStates(stored);
    }

    try {
      await invalidateActiveAuctionListCache(deps.redis);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to invalidate auction list cache");
    }

    await clearConversationState(deps, context.userId);

    const success = t("bot.create.success", context.locale);
    const details = t("bot.create.successDetails", context.locale, {
      id: inserted.insertedId.toHexString()
    });
    await sendMessage(deps, context.chatId, `${success}\n\n${details}`);
  } catch (error) {
    const message =
      error instanceof Error
        ? t("bot.create.error", context.locale, { error: error.message })
        : t("bot.error.tryAgain", context.locale);
    await sendMessage(deps, context.chatId, message);
  }
}

async function handleWithdrawAmountInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const amount = parseFloat(text);
  const availableBalance = (context.state?.data.availableBalance as number) ?? 0;
  const currency = (context.state?.data.currency as string) ?? resolveDefaultCurrency(deps);
  const minAmount = deps.config.crypto.withdrawal.minAmount;

  if (!Number.isFinite(amount) || amount <= 0) {
    await sendMessage(deps, context.chatId, t("bot.withdraw.invalidAmount", context.locale));
    return;
  }

  if (amount < minAmount) {
    const errorMsg = t("bot.withdraw.amountTooLow", context.locale, {
      min: formatAmount(minAmount),
      currency
    });
    await sendMessage(deps, context.chatId, errorMsg);
    return;
  }

  if (amount > availableBalance) {
    const errorMsg = t("bot.withdraw.amountTooHigh", context.locale, {
      max: formatAmount(availableBalance),
      currency
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
  const currency = (context.state?.data.currency as string) ?? resolveDefaultCurrency(deps);

  if (address.length < 10) {
    await sendMessage(
      deps,
      context.chatId,
      t("bot.withdraw.invalidAddress", context.locale, { currency })
    );
    return;
  }

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "withdraw:memo",
    data: { ...context.state!.data, amount, currency, address },
    locale: context.locale,
    updatedAt: new Date()
  });

  const prompt = t("bot.withdraw.promptMemo", context.locale);
  await sendMessage(deps, context.chatId, prompt);
}

async function handleWithdrawMemoInput(
  deps: ServiceDependencies,
  context: BotContext,
  text: string
): Promise<void> {
  const address = (context.state?.data.address as string | undefined)?.trim() ?? "";
  const amount = (context.state?.data.amount as number) ?? 0;
  const currency = (context.state?.data.currency as string) ?? resolveDefaultCurrency(deps);

  if (!address || !Number.isFinite(amount) || amount <= 0) {
    await sendMessage(deps, context.chatId, t("bot.error.sessionExpired", context.locale));
    return;
  }

  const memo = normalizeOptionalInput(text);

  await setConversationState(deps, context.userId, {
    userId: context.userId,
    step: "withdraw:confirm",
    data: { ...context.state!.data, amount, currency, address, memo },
    locale: context.locale,
    updatedAt: new Date()
  });

  const confirmation = t("bot.withdraw.confirmation", context.locale, {
    amount: formatAmount(amount),
    currency,
    address
  });
  const memoLine = memo ? t("bot.withdraw.memo", context.locale, { memo }) : "";
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: t("bot.withdraw.confirmYes", context.locale),
          callback_data: "withdraw:confirm"
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

  const message = memoLine ? `${confirmation}\n${memoLine}` : confirmation;
  await sendMessage(deps, context.chatId, message, { reply_markup: keyboard });
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
  } else if (parts[0] === "auctions" && parts[1] === "list") {
    await handleAuctionsCommand(deps, context);
  } else if (parts[0] === "create" && parts[1] === "antisniping") {
    const choice = parts[2] ?? "";
    if (choice === "yes" || choice === "no") {
      await handleCreateAntiSnipingSelection(deps, context, choice === "yes");
    }
  } else if (parts[0] === "wallet") {
    if (parts[1] === "deposit") {
      await handleDepositCommand(deps, context);
    } else if (parts[1] === "withdraw") {
      await handleWithdrawCommand(deps, context);
    }
  } else if (parts[0] === "settings") {
    if (parts[1] === "help") {
      await handleHelpCommand(deps, context);
    } else if (parts[1] === "language") {
      await handleLanguageCommand(deps, context);
    }
  } else if (parts[0] === "bid") {
    if (parts[1] === "start") {
      await handleStartBid(deps, context, parts[2] ?? "");
    } else if (parts[1] === "confirm") {
      await handleConfirmBid(deps, context, parts[2] ?? "", parseFloat(parts[3] ?? "0"));
    }
  } else if (parts[0] === "withdraw") {
    if (parts[1] === "confirm") {
      const amount = (context.state?.data.amount as number) ?? parseFloat(parts[2] ?? "0");
      const address = (context.state?.data.address as string) ?? "";
      const memo = (context.state?.data.memo as string | undefined) ?? undefined;
      const currency =
        (context.state?.data.currency as string) ?? resolveDefaultCurrency(deps);

      if (!address || !Number.isFinite(amount) || amount <= 0) {
        await answerCallbackQuery(deps, queryId, t("bot.error.sessionExpired", context.locale));
        return;
      }

      await clearConversationState(deps, context.userId);
      await handleConfirmWithdraw(deps, context, amount, address, currency, memo);
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
  const auctions = deps.mongo.db.collection<AuctionDocument>(mongoCollections.auctions);
  const auction = await auctions.findOne({ _id: auctionId });

  if (!auction) {
    await sendMessage(deps, context.chatId, t("errors.notFound", context.locale));
    return;
  }

  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const userBid = await bids.findOne({ auctionId, userId: context.userId, active: true });

  let snapshot: AuctionSnapshotCache | null = null;
  try {
    snapshot = await readAuctionSnapshotFromRedis(deps.redis, auctionIdStr);
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to read auction snapshot cache");
  }

  const name = snapshot?.title ?? auction.title ?? "Unnamed";
  const description = auction.description ?? "";
  const currency = snapshot?.currency ?? auction.currency ?? resolveDefaultCurrency(deps);
  const status = snapshot?.status ?? auction.status ?? "unknown";
  const currentRoundIndex = snapshot?.currentRoundIndex ?? auction.currentRoundIndex ?? 0;
  const currentRound = currentRoundIndex !== null ? currentRoundIndex + 1 : 0;
  const totalRounds = auction.rounds?.length ?? 0;
  const roundStatus = snapshot?.roundStatus ?? auction.roundStatus ?? null;

  let roundState: RoundStateCache | null = null;
  if (currentRoundIndex !== null) {
    try {
      roundState = await readRoundStateFromRedis(deps.redis, auctionIdStr, currentRoundIndex);
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to read round state cache");
    }
  }

  const roundConfig =
    auction.rounds?.find((round) => round.index === currentRoundIndex) ?? auction.rounds?.[0];
  const allocation = roundState?.allocationSize ?? roundConfig?.allocationSize ?? 0;
  const effectiveEndAt =
    roundState?.effectiveEndAt ??
    snapshot?.roundEffectiveEndAt ??
    auction.roundEffectiveEndAt ??
    roundConfig?.endAt ??
    null;
  const timeRemainingText =
    effectiveEndAt && (roundState?.status ?? roundStatus) === "live"
      ? formatTimeRemaining(effectiveEndAt, new Date(), context.locale)
      : null;

  const topLimit = Math.max(1, allocation);
  const topBids = await loadTopBids(deps, auctionId, auctionIdStr, topLimit);

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

  const lines = [title, "", nameText];
  if (description.trim().length > 0) {
    lines.push(description);
  }
  lines.push("", currencyText, roundText, statusText, allocationText);
  if (timeRemainingText) {
    lines.push(timeRemainingText);
  }
  lines.push("", bidText);

  if (topBids.length > 0) {
    lines.push("", t("bot.auction.details.topBids", context.locale));
    topBids.forEach((bid, index) => {
      lines.push(
        t("bot.auction.details.bid", context.locale, {
          rank: index + 1,
          amount: formatAmount(bid.amount),
          currency
        })
      );
    });
  }

  const message = lines.join("\n");

  const buttons = [];
  const canBid = status === "live" && (roundState?.status ?? roundStatus) === "live";
  if (canBid) {
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

  if (!auction || auction.status !== "live") {
    await sendMessage(deps, context.chatId, t("errors.auctionNotActive", context.locale));
    return;
  }

  let roundStatus = auction.roundStatus ?? null;
  try {
    const snapshot = await readAuctionSnapshotFromRedis(deps.redis, auctionIdStr);
    if (snapshot?.roundStatus) {
      roundStatus = snapshot.roundStatus;
    }
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to read auction snapshot cache");
  }

  if (roundStatus && roundStatus !== "live") {
    await sendMessage(deps, context.chatId, t("errors.auctionNotActive", context.locale));
    return;
  }

  const currency = auction.currency ?? resolveDefaultCurrency(deps);

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

  if (!auction) {
    await sendMessage(deps, context.chatId, t("errors.notFound", context.locale));
    return;
  }

  const bidService = createBidService(deps);
  const currency = auction.currency ?? resolveDefaultCurrency(deps);

  try {
    const result = await bidService.placeBid({
      auctionId,
      userId: context.userId,
      amount,
      idempotencyKey: randomUUID(),
      audit: { source: "telegram", actorId: context.userId },
      ip: `telegram:${context.userId}`
    });

    const success = t("bot.bid.success", context.locale);
    const successAmount = t("bot.bid.successAmount", context.locale, {
      amount: formatAmount(result.bid.amount),
      currency
    });
    const successHeld = t("bot.bid.successHeld", context.locale, {
      held: formatAmount(result.balance.held),
      currency
    });

    await sendMessage(deps, context.chatId, `${success}\n\n${successAmount}\n${successHeld}`);
  } catch (error) {
    if (error instanceof BidError) {
      await sendMessage(deps, context.chatId, formatBidErrorMessage(error, context.locale));
      return;
    }
    if (error instanceof LedgerError) {
      const message =
        error.code === "insufficient_funds"
          ? t("errors.insufficientBalance", context.locale)
          : t("bot.bid.error", context.locale, { error: error.message });
      await sendMessage(deps, context.chatId, message);
      return;
    }
    const fallback =
      error instanceof Error
        ? t("bot.bid.error", context.locale, { error: error.message })
        : t("bot.error.tryAgain", context.locale);
    await sendMessage(deps, context.chatId, fallback);
  }
}

async function handleConfirmWithdraw(
  deps: ServiceDependencies,
  context: BotContext,
  amount: number,
  address: string,
  currency: string,
  memo?: string
): Promise<void> {
  const processingMsg = t("bot.withdraw.processing", context.locale);
  await sendMessage(deps, context.chatId, processingMsg);

  const cryptoGateway = createCryptoGatewayService(deps);

  try {
    const result = await cryptoGateway.requestWithdrawal({
      userId: context.userId,
      currency,
      amount,
      destinationAddress: address,
      memo: memo && memo.length > 0 ? memo : undefined,
      idempotencyKey: randomUUID()
    });

    if (result.decision === "approve") {
      const success = t("bot.withdraw.success", context.locale);
      const successMessage = t("bot.withdraw.successMessage", context.locale, {
        amount: formatAmount(amount),
        currency
      });
      await sendMessage(deps, context.chatId, `${success}\n\n${successMessage}`);
      return;
    }

    const decisionMessage = buildWithdrawalDecisionMessage(
      context.locale,
      result.decision,
      result.flags,
      result.violations
    );
    await sendMessage(deps, context.chatId, decisionMessage);
  } catch (error) {
    if (error instanceof CryptoGatewayError || error instanceof LedgerError) {
      await sendMessage(
        deps,
        context.chatId,
        t("bot.withdraw.error", context.locale, { error: error.message })
      );
      return;
    }
    await sendMessage(deps, context.chatId, t("bot.error.tryAgain", context.locale));
  }
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
      [{ text: t("bot.menu.balance", locale) }, { text: t("bot.menu.auctions", locale) }],
      [{ text: t("bot.menu.create", locale) }, { text: t("bot.menu.settings", locale) }]
    ],
    resize_keyboard: true
  };
}

function buildBalanceActionsKeyboard(locale: string, includeWithdraw: boolean) {
  const buttons = [
    {
      text: t("bot.menu.deposit", locale),
      callback_data: "wallet:deposit"
    }
  ];
  if (includeWithdraw) {
    buttons.push({
      text: t("bot.menu.withdraw", locale),
      callback_data: "wallet:withdraw"
    });
  }
  return { inline_keyboard: [buttons] };
}

function resolveMenuCommand(text: string, locales: string[]): string | null {
  if (!text) {
    return null;
  }

  const mappings = [
    { key: "bot.menu.balance", command: "/balance" },
    { key: "bot.menu.deposit", command: "/deposit" },
    { key: "bot.menu.auctions", command: "/auctions" },
    { key: "bot.menu.create", command: "/create" },
    { key: "bot.menu.withdraw", command: "/withdraw" },
    { key: "bot.menu.settings", command: "/settings" },
    { key: "bot.menu.help", command: "/help" },
    { key: "bot.menu.language", command: "/language" }
  ];

  const fallbackLocales = locales.length > 0 ? locales : ["en"];
  for (const locale of fallbackLocales) {
    for (const mapping of mappings) {
      if (text === t(mapping.key, locale)) {
        return mapping.command;
      }
    }
  }

  return null;
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

function formatTimeRemaining(target: Date, now: Date, locale: string): string | null {
  const diffMs = target.getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null;
  }
  return t("bot.auction.details.timeRemaining", locale, { time: formatDuration(diffMs) });
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

async function loadTopBids(
  deps: ServiceDependencies,
  auctionId: ObjectId,
  auctionIdText: string,
  limit: number
): Promise<Array<WithId<BidDocument>>> {
  if (limit <= 0) {
    return [];
  }

  const bids = deps.mongo.db.collection<BidDocument>(mongoCollections.bids);
  const rankingKey = buildRankingKey(auctionIdText);
  let members: string[] = [];

  try {
    members = await deps.redis.zrevrange(rankingKey, 0, limit - 1);
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to read bid ranking cache");
  }

  let orderedBidIds = members
    .map((member) => parseRankingMember(member).bidId)
    .filter((bidId) => bidId.length > 0);

  let bidDocs: Array<WithId<BidDocument>> = [];
  if (orderedBidIds.length > 0) {
    const objectIds = orderedBidIds
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));
    if (objectIds.length > 0) {
      bidDocs = await bids.find({ _id: { $in: objectIds } }).toArray();
    }
  }

  if (bidDocs.length === 0) {
    bidDocs = await bids
      .find({ auctionId, active: true })
      .sort({ amount: -1, createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
    orderedBidIds = bidDocs.map((bid) => bid._id.toHexString());
  }

  const byId = new Map(bidDocs.map((bid) => [bid._id.toHexString(), bid]));
  return orderedBidIds
    .map((id) => byId.get(id))
    .filter((bid): bid is WithId<BidDocument> => Boolean(bid));
}

function resolveDefaultCurrency(deps: ServiceDependencies): string {
  return deps.config.crypto.supportedCurrencies[0] ?? "USDT";
}

function formatBidErrorMessage(error: BidError, locale: string): string {
  switch (error.code) {
    case "bid_too_low":
      return t("errors.bidTooLow", locale);
    case "auction_not_found":
    case "round_not_found":
      return t("errors.notFound", locale);
    case "auction_not_live":
    case "round_not_live":
      return t("errors.auctionNotActive", locale);
    case "rate_limited":
      return t("errors.rateLimited", locale, { seconds: 60 });
    case "round_locked":
    case "idempotency_conflict":
      return t("bot.error.tryAgain", locale);
    default:
      return t("bot.bid.error", locale, { error: error.message });
  }
}

function buildWithdrawalDecisionMessage(
  locale: string,
  decision: "review" | "reject",
  flags: string[],
  violations: string[]
): string {
  const lines = [
    decision === "review"
      ? t("web.withdraw.reviewTitle", locale)
      : t("web.withdraw.rejectedTitle", locale),
    "",
    decision === "review"
      ? t("web.withdraw.reviewBody", locale)
      : t("web.withdraw.rejectedBody", locale)
  ];

  const notes = [
    ...formatWithdrawalSignals(locale, "web.withdraw.flagsTitle", flags, withdrawalFlagLabels),
    ...formatWithdrawalSignals(
      locale,
      "web.withdraw.issuesTitle",
      violations,
      withdrawalViolationLabels
    )
  ];

  if (notes.length > 0) {
    lines.push("", ...notes);
  }

  return lines.join("\n");
}

const withdrawalFlagLabels: Record<string, string> = {
  new_address: "web.withdraw.flag.new_address",
  first_withdrawal: "web.withdraw.flag.first_withdrawal",
  amount_spike: "web.withdraw.flag.amount_spike",
  manual_threshold: "web.withdraw.flag.manual_threshold"
};

const withdrawalViolationLabels: Record<string, string> = {
  min_amount: "web.withdraw.violation.min_amount",
  max_amount: "web.withdraw.violation.max_amount",
  daily_limit: "web.withdraw.violation.daily_limit",
  hourly_limit: "web.withdraw.violation.hourly_limit",
  daily_count_limit: "web.withdraw.violation.daily_count_limit",
  cooldown: "web.withdraw.violation.cooldown",
  allowlist_required: "web.withdraw.violation.allowlist_required"
};

function formatWithdrawalSignals(
  locale: string,
  titleKey: string,
  items: string[],
  labels: Record<string, string>
): string[] {
  if (!items || items.length === 0) {
    return [];
  }

  const lines = [t(titleKey, locale)];
  for (const item of items) {
    const labelKey = labels[item];
    const label = labelKey ? t(labelKey, locale) : item;
    lines.push(`- ${label}`);
  }

  return lines;
}

function normalizeOptionalInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "skip" || lower === "-" || lower === "none") {
    return undefined;
  }
  return trimmed;
}

function ensureTelegramConfig(deps: ServiceDependencies): void {
  if (!deps.config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for bot service.");
  }
}
