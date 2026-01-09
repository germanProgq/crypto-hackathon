// Telegram bot service entrypoint.
import { startService } from "../../shared/service.js";
import { registerNotificationConsumer } from "./notificationConsumer.js";

void startService({
  serviceName: "bot",
  defaultPort: 4004,
  registerRoutes: registerNotificationConsumer
});
