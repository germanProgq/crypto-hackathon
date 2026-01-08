// Worker service entrypoint.
import { startService } from "../../shared/service.js";
import { registerWorkerTasks } from "./auctionRoundScheduler.js";

void startService({
  serviceName: "workers",
  defaultPort: 4006,
  registerRoutes: registerWorkerTasks
});
