import { defineConfig } from "drizzle-kit";
import path from "path";
import { readFileSync } from "fs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
    ...(process.env.PGSSLROOTCERT ? { ssl: { ca: readFileSync(process.env.PGSSLROOTCERT, "utf8") } } : {}),
  },
});
