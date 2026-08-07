import { readFileSync } from "fs";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Managed Postgres providers (RDS, etc.) often require TLS against their own
// CA - point PGSSLROOTCERT at the downloaded .pem to verify against it.
const ssl = process.env.PGSSLROOTCERT
  ? { ca: readFileSync(process.env.PGSSLROOTCERT, "utf8"), rejectUnauthorized: true }
  : undefined;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
export const db = drizzle(pool, { schema });

export * from "./schema";
