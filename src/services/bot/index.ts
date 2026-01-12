// Telegram bot service entrypoint.
import type { FastifyInstance } from "fastify";
import type { ServiceDependencies } from "../../shared/service.js";
import { startService } from "../../shared/service.js";
import { registerNotificationConsumer } from "./notificationConsumer.js";
import { registerBotHandlers } from "./botHandlers.js";

async function registerAll(
  app: FastifyInstance,
  deps: ServiceDependencies
): Promise<void> {
  await registerNotificationConsumer(app, deps);
  await registerBotHandlers(app, deps);
}

void startService({
  serviceName: "bot",
  defaultPort: 4004,
  registerRoutes: registerAll
});
