// Worker service entrypoint.
import { startService } from "../../shared/service";

void startService({ serviceName: "workers", defaultPort: 4006 });
