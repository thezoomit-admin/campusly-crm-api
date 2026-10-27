import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config } from "./config";
import { HttpError } from "./lib/http-error";
import { activitiesRouter } from "./modules/activities/activities.routes";
import {
  applicationsRouter,
  leadApplicationsRouter,
} from "./modules/applications/applications.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { attachSession } from "./modules/auth/attach-session.middleware";
import { authRouter } from "./modules/auth/auth.routes";
import { campaignsRouter } from "./modules/campaigns/campaigns.routes";
import { countryAssignmentRouter } from "./modules/country-assignment/country-assignment.routes";
import { communicationsRouter } from "./modules/communications/communications.routes";
import { emailRouter } from "./modules/email/email.routes";
import { employeesRouter } from "./modules/employees/employees.routes";
import { filesRouter } from "./modules/files/files.routes";
import { followUpsRouter } from "./modules/follow-ups/follow-ups.routes";
import { meetingsRouter } from "./modules/meetings/meetings.routes";
import { healthRouter } from "./modules/health/health.routes";
import { publicWebsiteRouter } from "./modules/integrations/public-website.routes";
import { webhooksRouter } from "./modules/integrations/webhooks.routes";
import { leadsRouter } from "./modules/leads/leads.routes";
import { masterDataRouter } from "./modules/master-data/master-data.routes";
import { meRouter } from "./modules/me/me.routes";
import { metaLeadsRouter } from "./modules/meta-leads/meta-leads.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { packagesRouter } from "./modules/packages/packages.routes";
import { serviceOffersRouter } from "./modules/packages/service-offers.routes";
import {
  leadPaymentsRouter,
  paymentsRouter,
  receiptsRouter,
} from "./modules/payments/payments.routes";
import { performanceRouter } from "./modules/performance/performance.routes";
import { permissionsRouter } from "./modules/permissions/permissions.routes";
import { pipelineRouter } from "./modules/pipeline/pipeline.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { searchRouter } from "./modules/search/search.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { serviceItemsRouter } from "./modules/service-items/service-items.routes";
import { usersRouter } from "./modules/users/users.routes";
import { whatsappRouter } from "./modules/whatsapp/whatsapp.routes";
import { whatsappWebhookRouter } from "./modules/whatsapp/whatsapp.webhook";

export function createApp() {
  const app = express();

  const allowedOrigins = new Set([
    ...config.clientOrigins,
    ...config.websiteOrigins,
    "https://crm.campusly.com",
    "https://campusly-crm.vercel.app",
  ]);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  const captureRawBody = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer,
  ) => {
    req.rawBody = buf;
  };
  const jsonParser = express.json({ limit: "256kb", verify: captureRawBody });
  const emailWebhookParser = express.json({
    limit: "12mb",
    verify: captureRawBody,
  });
  app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api/webhooks/email")) {
      emailWebhookParser(req, res, next);
      return;
    }
    jsonParser(req, res, next);
  });
  app.use(cookieParser());
  app.use(attachSession);

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      message: "Campusly CRM API is running successfully.",
      statusCode: 200,
      data: {
        service: "Campusly CRM API",
        environment: config.env,
        timestamp: new Date().toISOString(),
      },
      links: {
        health: "/api/health",
      },
    });
  });

  app.use("/api/health", healthRouter);
  app.use("/api/public", publicWebsiteRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/employees", employeesRouter);
  app.use("/api/roles", rolesRouter);
  app.use("/api/permissions", permissionsRouter);
  app.use("/api/master-data", masterDataRouter);
  app.use("/api/country-assignment-rules", countryAssignmentRouter);
  app.use("/api/service-items", serviceItemsRouter);
  app.use("/api/packages", packagesRouter);
  app.use("/api/leads/:leadId/service-offers", serviceOffersRouter);
  app.use("/api/leads/:leadId/payments", leadPaymentsRouter);
  app.use("/api/leads/:leadId/applications", leadApplicationsRouter);
  app.use("/api/applications", applicationsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/receipts", receiptsRouter);
  app.use("/api/audit-logs", auditRouter);
  app.use("/api/activities", activitiesRouter);
  app.use("/api/leads", leadsRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/follow-ups", followUpsRouter);
  app.use("/api/meetings", meetingsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/communications", communicationsRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/whatsapp", whatsappRouter);
  app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);
  app.use("/api/email", emailRouter);
  app.use("/api/meta-leads", metaLeadsRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/pipeline", pipelineRouter);
  app.use("/api/performance", performanceRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/settings", settingsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.path });
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof HttpError) {
        res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.extra || {}),
        });
        return;
      }

      if (error instanceof SyntaxError) {
        res
          .status(400)
          .json({ error: "Invalid request body.", code: "INVALID_INPUT" });
        return;
      }

      console.error(error);
      res.status(500).json({
        error: "Unable to process the request. Please try again.",
        code: "SERVER_ERROR",
      });
    },
  );

  return app;
}

const app = createApp();

export default app;
