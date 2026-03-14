import { tsImport } from "tsx/esm/api";

const { default: config } = await tsImport(
  "./eslint.config.ts",
  import.meta.url
);

export default config;
