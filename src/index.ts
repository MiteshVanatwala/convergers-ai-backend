import { buildServer } from "./gateway";

const port = Number(process.env.PORT ?? 3000);

buildServer()
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`backend listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
