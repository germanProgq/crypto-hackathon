// Web service entrypoint.
import { startService } from "../../shared/service.js";
import { registerWebRoutes } from "./routes.js";

void startService({
  serviceName: "web",
  defaultPort: 4005,
  registerRoutes: registerWebRoutes
});
