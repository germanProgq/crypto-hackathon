// Bot notification delivery tests.
import { describe, expect, it } from "vitest";
import { t } from "../src/shared/i18n/index.js";

describe("Bot Notification Messages", () => {
  describe("Round Result Notifications", () => {
    it("builds winner notification in English", () => {
      const message = t("bot.roundResult.winner", "en", {
        round: 2,
        auctionId: "test-auction",
        amount: "100.5",
        currency: "TON",
        rank: 1
      });
      expect(message).toContain("Congratulations");
      expect(message).toContain("round 2");
      expect(message).toContain("100.5");
      expect(message).toContain("TON");
    });

    it("builds winner notification in Russian", () => {
      const message = t("bot.roundResult.winner", "ru", {
        round: 2,
        auctionId: "test-auction",
        amount: "100.5",
        currency: "TON",
        rank: 1
      });
      expect(message).toContain("Поздравляем");
      expect(message).toContain("раунд 2");
      expect(message).toContain("100.5");
      expect(message).toContain("TON");
    });

    it("builds non-winner notification in English", () => {
      const message = t("bot.roundResult.nonWinner", "en", {
        round: 1,
        auctionId: "test-auction",
        amount: "50",
        currency: "TON"
      });
      expect(message).toContain("Round 1");
      expect(message).toContain("did not win");
      expect(message).toContain("continues to the next round");
    });

    it("builds non-winner notification in Russian", () => {
      const message = t("bot.roundResult.nonWinner", "ru", {
        round: 1,
        auctionId: "test-auction",
        amount: "50",
        currency: "TON"
      });
      expect(message).toContain("Раунд 1");
      expect(message).toContain("не выиграла");
      expect(message).toContain("следующем раунде");
    });
  });

  describe("Bid Confirmation Notifications", () => {
    it("builds bid confirmed notification in English", () => {
      const message = t("bot.notification.bidConfirmed", "en", {
        amount: "75.25",
        currency: "TON",
        auctionId: "test-auction"
      });
      expect(message).toContain("confirmed");
      expect(message).toContain("75.25");
      expect(message).toContain("TON");
    });

    it("builds bid confirmed notification in Russian", () => {
      const message = t("bot.notification.bidConfirmed", "ru", {
        amount: "75.25",
        currency: "TON",
        auctionId: "test-auction"
      });
      expect(message).toContain("подтверждена");
      expect(message).toContain("75.25");
      expect(message).toContain("TON");
    });
  });

  describe("Withdrawal Notifications", () => {
    it("builds withdrawal broadcasted notification in English", () => {
      const message = t("bot.notification.withdrawalBroadcasted", "en", {
        amount: "100",
        currency: "TON",
        txHash: "0xabc123"
      });
      expect(message).toContain("broadcasted");
      expect(message).toContain("100");
      expect(message).toContain("0xabc123");
    });

    it("builds withdrawal confirmed notification in English", () => {
      const message = t("bot.notification.withdrawalConfirmed", "en", {
        amount: "100",
        currency: "TON"
      });
      expect(message).toContain("confirmed");
      expect(message).toContain("100");
    });

    it("builds withdrawal failed notification in English", () => {
      const message = t("bot.notification.withdrawalFailed", "en", {
        amount: "100",
        currency: "TON",
        error: "Insufficient gas"
      });
      expect(message).toContain("failed");
      expect(message).toContain("100");
      expect(message).toContain("Insufficient gas");
    });

    it("builds withdrawal notifications in Russian", () => {
      const broadcasted = t("bot.notification.withdrawalBroadcasted", "ru", {
        amount: "100",
        currency: "TON",
        txHash: "0xabc"
      });
      expect(broadcasted).toContain("отправлен");

      const confirmed = t("bot.notification.withdrawalConfirmed", "ru", {
        amount: "100",
        currency: "TON"
      });
      expect(confirmed).toContain("подтвержден");

      const failed = t("bot.notification.withdrawalFailed", "ru", {
        amount: "100",
        currency: "TON",
        error: "Error"
      });
      expect(failed).toContain("не удался");
    });
  });

  describe("Auction Event Notifications", () => {
    it("builds auction starting notification in English", () => {
      const message = t("bot.notification.auctionStarting", "en", {
        name: "Premium NFT"
      });
      expect(message).toContain("starting soon");
      expect(message).toContain("Premium NFT");
    });

    it("builds round starting notification in English", () => {
      const message = t("bot.notification.roundStarting", "en", {
        round: 3,
        auctionId: "test-auction"
      });
      expect(message).toContain("Round 3");
      expect(message).toContain("starting");
    });

    it("builds auction event notifications in Russian", () => {
      const auctionStarting = t("bot.notification.auctionStarting", "ru", {
        name: "Premium NFT"
      });
      expect(auctionStarting).toContain("начнется");

      const roundStarting = t("bot.notification.roundStarting", "ru", {
        round: 3,
        auctionId: "test-auction"
      });
      expect(roundStarting).toContain("Раунд 3");
      expect(roundStarting).toContain("начинается");
    });
  });
});

describe("Bot Command Messages", () => {
  describe("Start Command", () => {
    it("displays welcome message in English", () => {
      const welcome = t("bot.start.welcome", "en");
      expect(welcome).toContain("Welcome");
      expect(welcome).toContain("Auction Platform");
    });

    it("displays welcome message in Russian", () => {
      const welcome = t("bot.start.welcome", "ru");
      expect(welcome).toContain("Добро пожаловать");
      expect(welcome).toContain("платформу аукционов");
    });
  });

  describe("Balance Command", () => {
    it("displays balance information in English", () => {
      const available = t("bot.balance.available", "en", {
        amount: "100.5",
        currency: "TON"
      });
      expect(available).toContain("Available");
      expect(available).toContain("100.5");

      const held = t("bot.balance.held", "en", {
        amount: "50",
        currency: "TON"
      });
      expect(held).toContain("Held");
      expect(held).toContain("50");
    });

    it("displays balance information in Russian", () => {
      const available = t("bot.balance.available", "ru", {
        amount: "100.5",
        currency: "TON"
      });
      expect(available).toContain("Доступно");

      const held = t("bot.balance.held", "ru", {
        amount: "50",
        currency: "TON"
      });
      expect(held).toContain("В ставках");
    });

    it("displays no balance message", () => {
      expect(t("bot.balance.noBalance", "en")).toContain("don't have any balance");
      expect(t("bot.balance.noBalance", "ru")).toContain("нет баланса");
    });
  });

  describe("Deposit Command", () => {
    it("displays deposit instructions in English", () => {
      const instructions = t("bot.deposit.instructions", "en", { currency: "TON" });
      expect(instructions).toContain("Send");
      expect(instructions).toContain("TON");

      const warning = t("bot.deposit.warning", "en", { currency: "TON" });
      expect(warning).toContain("Only send");
      expect(warning).toContain("will be lost");
    });

    it("displays deposit instructions in Russian", () => {
      const instructions = t("bot.deposit.instructions", "ru", { currency: "TON" });
      expect(instructions).toContain("Отправьте");
      expect(instructions).toContain("TON");

      const warning = t("bot.deposit.warning", "ru", { currency: "TON" });
      expect(warning).toContain("Отправляйте только");
      expect(warning).toContain("будут потеряны");
    });
  });

  describe("Bid Command", () => {
    it("displays bid prompts in English", () => {
      const prompt = t("bot.bid.prompt", "en", { currency: "TON" });
      expect(prompt).toContain("Enter");
      expect(prompt).toContain("bid amount");

      const success = t("bot.bid.success", "en");
      expect(success).toContain("successfully");
    });

    it("displays bid error messages in English", () => {
      const insufficient = t("bot.bid.insufficientBalance", "en", {
        required: "100",
        available: "50",
        currency: "TON"
      });
      expect(insufficient).toContain("Insufficient");
      expect(insufficient).toContain("100");
      expect(insufficient).toContain("50");

      const tooLow = t("bot.bid.tooLow", "en", {
        current: "75",
        currency: "TON"
      });
      expect(tooLow).toContain("higher");
      expect(tooLow).toContain("75");
    });

    it("displays bid messages in Russian", () => {
      const prompt = t("bot.bid.prompt", "ru", { currency: "TON" });
      expect(prompt).toContain("Введите");

      const success = t("bot.bid.success", "ru");
      expect(success).toContain("успешно");

      const insufficient = t("bot.bid.insufficientBalance", "ru", {
        required: "100",
        available: "50",
        currency: "TON"
      });
      expect(insufficient).toContain("Недостаточно");
    });
  });

  describe("Withdraw Command", () => {
    it("displays withdrawal prompts in English", () => {
      const promptAmount = t("bot.withdraw.promptAmount", "en", { currency: "TON" });
      expect(promptAmount).toContain("Enter");
      expect(promptAmount).toContain("withdrawal amount");

      const promptAddress = t("bot.withdraw.promptAddress", "en", { currency: "TON" });
      expect(promptAddress).toContain("Enter");
      expect(promptAddress).toContain("address");
    });

    it("displays withdrawal confirmations in English", () => {
      const confirmation = t("bot.withdraw.confirmation", "en", {
        amount: "50",
        currency: "TON",
        address: "0xabc123"
      });
      expect(confirmation).toContain("Confirm");
      expect(confirmation).toContain("50");
      expect(confirmation).toContain("0xabc123");
    });

    it("displays withdrawal messages in Russian", () => {
      const promptAmount = t("bot.withdraw.promptAmount", "ru", { currency: "TON" });
      expect(promptAmount).toContain("Введите");
      expect(promptAmount).toContain("сумму");

      const success = t("bot.withdraw.success", "ru");
      expect(success).toContain("запрошен");
    });
  });

  describe("Error Messages", () => {
    it("displays rate limit error in English", () => {
      const message = t("errors.rateLimited", "en", { seconds: 60 });
      expect(message).toContain("Too many");
      expect(message).toContain("60");
    });

    it("displays error messages in both locales", () => {
      expect(t("errors.insufficientBalance", "en")).toContain("Insufficient");
      expect(t("errors.insufficientBalance", "ru")).toContain("Недостаточно");

      expect(t("errors.auctionNotActive", "en")).toContain("not active");
      expect(t("errors.auctionNotActive", "ru")).toContain("неактивен");

      expect(t("bot.error.tryAgain", "en")).toContain("try again");
      expect(t("bot.error.tryAgain", "ru")).toContain("Попробуйте еще раз");
    });
  });

  describe("Menu Items", () => {
    it("displays menu items in English", () => {
      expect(t("bot.menu.balance", "en")).toContain("Balance");
      expect(t("bot.menu.deposit", "en")).toContain("Deposit");
      expect(t("bot.menu.auctions", "en")).toContain("Auctions");
      expect(t("bot.menu.withdraw", "en")).toContain("Withdraw");
    });

    it("displays menu items in Russian", () => {
      expect(t("bot.menu.balance", "ru")).toContain("Баланс");
      expect(t("bot.menu.deposit", "ru")).toContain("Пополнение");
      expect(t("bot.menu.auctions", "ru")).toContain("Аукционы");
      expect(t("bot.menu.withdraw", "ru")).toContain("Вывод");
    });
  });
});

describe("Bot Locale Support", () => {
  it("supports English locale", () => {
    const message = t("bot.start.welcome", "en");
    expect(message).not.toBe("bot.start.welcome");
    expect(message.length).toBeGreaterThan(0);
  });

  it("supports Russian locale", () => {
    const message = t("bot.start.welcome", "ru");
    expect(message).not.toBe("bot.start.welcome");
    expect(message.length).toBeGreaterThan(0);
  });

  it("falls back to English for missing keys", () => {
    const message = t("bot.nonexistent.key", "ru");
    expect(message).toBe("bot.nonexistent.key");
  });
});
