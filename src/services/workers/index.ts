// Purpose: worker service entrypoint.
import { startService } from "../../shared/service.js";
import { registerWorkerTasks as registerRoundScheduler } from "./auctionRoundScheduler.js";
import { registerRoundFinalizer } from "./roundFinalizer.js";

void startService({
  serviceName: "workers",
  defaultPort: 4006,
  registerRoutes: async (app, deps) => {
    await registerRoundScheduler(app, deps);
    await registerRoundFinalizer(app, deps);
  }
});
