// Crypto gateway service entrypoint.
import type { FastifyInstance } from "fastify";
import { startService, type ServiceDependencies } from "../../shared/service.js";
import { createWalletStrategy } from "./walletStrategy.js";
import { createDepositAddressService } from "./depositAddressService.js";
import { createDepositWatcher } from "./depositWatcher.js";
import { createWithdrawalService } from "./withdrawalService.js";
import { createWithdrawalSafetyValidator } from "./withdrawalSafetyValidator.js";
import { createLedgerRepository } from "../ledger/ledgerStore.js";
import { registerCryptoGatewayRoutes } from "./routes.js";

async function setupCryptoGateway(
  server: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  const walletStrategy = createWalletStrategy(deps.config.crypto.walletStrategy, {
    derivationPath: deps.config.crypto.hdDerivationPath,
    masterPublicKey: deps.config.crypto.masterPublicKey,
    hotWalletAddress: deps.config.crypto.hotWalletAddress
  });

  const depositAddressService = createDepositAddressService(deps.mongo, walletStrategy);

  const ledgerRepository = createLedgerRepository(deps.mongo);

  const depositWatcher = createDepositWatcher({
    mongo: deps.mongo,
    depositAddressService,
    ledgerService: ledgerRepository,
    confirmationThresholds: deps.config.crypto.depositConfirmations
  });

  const safetyValidator = createWithdrawalSafetyValidator(deps.mongo, {
    cooldownSeconds: deps.config.crypto.withdrawalCooldownSeconds,
    dailyLimitUSD: deps.config.crypto.withdrawalDailyLimitUSD,
    minAmount: deps.config.crypto.withdrawalMinAmount,
    anomalyThresholds: {
      maxWithdrawalsPerHour: 10,
      maxWithdrawalAmountMultiplier: 5
    }
  });

  const withdrawalService = createWithdrawalService({
    mongo: deps.mongo,
    ledgerService: ledgerRepository,
    safetyValidator,
    confirmationThresholds: deps.config.crypto.withdrawalConfirmations
  });

  registerCryptoGatewayRoutes(server, {
    depositAddressService,
    depositWatcher,
    withdrawalService
  });

  deps.logger.info("Crypto gateway initialized");
}

void startService({
  serviceName: "crypto-gateway",
  defaultPort: 4003,
  registerRoutes: setupCryptoGateway
});
