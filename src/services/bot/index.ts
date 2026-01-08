// Telegram bot service entrypoint.
import { startService } from "../../shared/service.js";

void startService({ serviceName: "bot", defaultPort: 4004 });
