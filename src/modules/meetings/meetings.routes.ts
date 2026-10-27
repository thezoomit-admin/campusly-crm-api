import { Router } from "express";
import { requestIp, requestUserAgent, routeParam } from "../../lib/request";
import { requireAuth, requirePermission } from "../auth/require-auth.middleware";
import {
  cancelMeeting,
  completeMeeting,
  createMeeting,
  rescheduleMeeting,
} from "./meetings.service";

export const meetingsRouter = Router();

meetingsRouter.use(requireAuth);

function body(req: { body: unknown }) {
  return (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
}

meetingsRouter.post(
  "/",
  requirePermission("follow_up:create"),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await createMeeting(req.auth!, body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

meetingsRouter.post(
  "/:id/complete",
  requirePermission("follow_up:edit"),
  async (req, res, next) => {
    try {
      res.json(
        await completeMeeting(
          req.auth!,
          routeParam(req.params.id),
          body(req),
          {
            ipAddress: requestIp(req),
            userAgent: requestUserAgent(req),
          },
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

meetingsRouter.post(
  "/:id/reschedule",
  requirePermission("follow_up:edit"),
  async (req, res, next) => {
    try {
      res.json(
        await rescheduleMeeting(
          req.auth!,
          routeParam(req.params.id),
          body(req),
          {
            ipAddress: requestIp(req),
            userAgent: requestUserAgent(req),
          },
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

meetingsRouter.post(
  "/:id/cancel",
  requirePermission("follow_up:edit"),
  async (req, res, next) => {
    try {
      res.json(
        await cancelMeeting(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);
