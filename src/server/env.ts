import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_APP_HANDLE: z.string().trim().min(1).optional(),
  SHOPIFY_APP_URL: z.string().url(),
  SCOPES: z.string().default("read_orders"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
  SHIPRELEASE_SECRET_ENCRYPTION_KEY: z.string().min(32),
  SHIPRELEASE_DEMO_MODE: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => ["1", "true", "yes", "on"].includes(value))
    .default("false"),
  SHIPRELEASE_DEMO_TAG: z.string().trim().min(1).default("shiprelease-demo"),
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000)
});

export const env = schema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
