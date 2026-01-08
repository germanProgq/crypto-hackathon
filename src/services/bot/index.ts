// Telegram bot service entrypoint.
import { startService } from "../../shared/service";

void startService({ serviceName: "bot", defaultPort: 4004 });
