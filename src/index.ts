import "dotenv/config";
import { loadEnv } from "./config/env";
import { buildServer } from "./infrastructure/http/server";

const env = loadEnv();

buildServer()
  .then((app) => app.listen({ port: env.port, host: "0.0.0.0" }))
  .then(() => console.log(`backend listening on :${env.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
