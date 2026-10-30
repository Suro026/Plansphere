import { clean } from "./clean";
import { seed } from "./seed";

const command = process.env.DEMO_COMMAND;

(async () => {
  if (command === "seed") await seed();
  else if (command === "clean") await clean();
  else throw new Error(`Unknown demo command "${command}". Use seed or clean.`);
})()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
