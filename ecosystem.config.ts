import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const config = {
  apps: [
    {
      name: "codex-telegram-claws",
      cwd: repoRoot,
      script: "src/index.ts",
      interpreter: "node_modules/.bin/tsx",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "512M",
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

export default config;
