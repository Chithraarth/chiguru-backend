import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import { firebaseAuthMiddleware } from "./middlewares/firebaseAuth";
import { razorpayWebhookHandler } from "./routes/subscription";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));
// Gzip responses — big win for photo-heavy JSON (work sessions, reports)
// going to farmers on slow rural connections.
app.use(compression());

// Razorpay needs the exact raw request bytes to verify a webhook's signature,
// so this must be mounted with express.raw() BEFORE the global express.json()
// below (which would otherwise consume/parse the body first).
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), razorpayWebhookHandler);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Verifies a Firebase ID token if present and attaches req.owner — never
// blocks by itself (see requireOwner for routes that must be signed in).
app.use(firebaseAuthMiddleware);

app.use("/api", router);

export default app;
