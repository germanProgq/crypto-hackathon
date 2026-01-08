// Ledger service entrypoint.
import { startService } from "../../shared/service.js";
import { registerLedgerRoutes } from "./routes.js";

void startService({
  serviceName: "ledger",
  defaultPort: 4002,
  registerRoutes: registerLedgerRoutes
});
