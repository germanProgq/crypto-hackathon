// Auction engine service entrypoint.
import { startService } from "../../shared/service.js";
import { registerAuctionRoutes } from "./routes.js";

void startService({
  serviceName: "auction-engine",
  defaultPort: 4001,
  registerRoutes: registerAuctionRoutes
});
