// Crypto gateway service entrypoint.
import { startService } from "../../shared/service.js";
import { registerCryptoGatewayRoutes } from "./routes.js";
import { registerCryptoGatewayTasks } from "./tasks.js";

void startService({
  serviceName: "crypto-gateway",
  defaultPort: 4003,
  registerRoutes: async (app, deps) => {
    await registerCryptoGatewayRoutes(app, deps);
    await registerCryptoGatewayTasks(app, deps);
  }
});
