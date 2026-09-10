import "dotenv/config";
import { buildServer } from "./gateway";

// Distinct from web's default dev port (3000) so both can run side by side.
const port = Number(process.env.PORT ?? 8787);

buildServer()
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`backend listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
