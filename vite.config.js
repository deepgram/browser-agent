import { defineConfig } from "vite";
import { createHtmlPlugin } from "vite-plugin-html";
import { resolve } from "path";

const dev = () => {
  const API_KEY = process.env.DG_API_KEY;

  if (!API_KEY) {
    throw new Error("missing DG_API_KEY environment variable");
  }

  return {
    define: {
      API_KEY: JSON.stringify(API_KEY),
    },
    plugins: createHtmlPlugin({
      template: "example/index.html",
    }),
  };
};

const prod = () => ({
  build: {
    lib: { entry: resolve(__dirname, "src/index.ts"), formats: ["es"] },
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) =>
  mode === "development" ? dev() : prod(),
);
