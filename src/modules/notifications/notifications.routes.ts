import { Router } from "express";
import { requestIp, requestUserAgent, routeParam } from "../../lib/request";
import { requireAuth, requirePermission } from "../auth/require-auth.middleware";
import {
  archiveNotification,
  getNotification,
  listNotificationConfig,
  listNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreferences,
  updateNotificationConfig,
} from "./notifications.service";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

function queryNumber(value: unknown) {
  const num = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function queryString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

notificationsRouter.get("/", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(
      await listNotifications(req.auth!, {
        limit: queryNumber(req.query.limit),
        unreadOnly: req.query.unreadOnly === "1" || req.query.unreadOnly === "true",
        scope: queryString(req.query.scope),
        status: queryString(req.query.status),
        eventType: queryString(req.query.eventType),
        priority: queryString(req.query.priority),
        leadId: queryString(req.query.leadId),
        search: queryString(req.query.search),
        from: queryString(req.query.from),
        to: queryString(req.query.to),
      }),
    );
  } catch (error) {
    next(error);
  }
});

notificationsRouter.get("/preferences", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(await listNotificationPreferences(req.auth!));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.put("/preferences", requirePermission("notification:view"), async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      items?: Array<{ eventType?: string; inApp?: boolean; email?: boolean; whatsapp?: boolean; browser?: boolean }>;
    };
    res.json(await saveNotificationPreferences(req.auth!, body));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.get("/config", requirePermission("notification:configure"), async (req, res, next) => {
  try {
    res.json(await listNotificationConfig(req.auth!));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.put("/config/:eventType", requirePermission("notification:configure"), async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    res.json(
      await updateNotificationConfig(req.auth!, routeParam(req.params.eventType), body, {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

notificationsRouter.get("/:id", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(await getNotification(req.auth!, routeParam(req.params.id)));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post("/:id/read", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(await markNotificationRead(req.auth!, routeParam(req.params.id)));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post("/:id/archive", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(await archiveNotification(req.auth!, routeParam(req.params.id)));
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post("/read-all", requirePermission("notification:view"), async (req, res, next) => {
  try {
    res.json(await markAllNotificationsRead(req.auth!));
  } catch (error) {
    next(error);
  }
});
