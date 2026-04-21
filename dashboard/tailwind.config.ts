import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        redin: {
          DEFAULT: "#1f2937",
          accent: "#f59e0b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
