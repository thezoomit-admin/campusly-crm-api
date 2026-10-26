import { Router } from "express";
import { requireAuth, requirePermission } from "../auth/require-auth.middleware";
import {
  getMyPreferences,
  getSettingsPage,
  getWorkspaceBrand,
  updateLeadSettings,
  updateMyPreferences,
  updateWorkspaceSettings,
} from "./settings.service";

export const settingsRouter = Router();

settingsRouter.get("/brand", requireAuth, async (_req, res, next) => {
  try {
    res.json(await getWorkspaceBrand());
  } catch (error) {
    next(error);
  }
});

settingsRouter.get("/preferences", requireAuth, async (req, res, next) => {
  try {
    res.json(await getMyPreferences(req.auth!.user.id));
  } catch (error) {
    next(error);
  }
});

settingsRouter.patch("/preferences", requireAuth, async (req, res, next) => {
  try {
    res.json(await updateMyPreferences(req.auth!.user.id, req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

settingsRouter.use(requireAuth, requirePermission("settings:view"));

settingsRouter.get("/", async (req, res, next) => {
  try {
    res.json(await getSettingsPage(req.auth!));
  } catch (error) {
    next(error);
  }
});

settingsRouter.patch(
  "/workspace",
  requirePermission("settings:configure", "You do not have permission to change workspace settings."),
  async (req, res, next) => {
    try {
      res.json(
        await updateWorkspaceSettings(req.auth!, req.body ?? {}, {
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

settingsRouter.patch(
  "/leads",
  requirePermission("settings:configure", "You do not have permission to change lead settings."),
  async (req, res, next) => {
    try {
      res.json(
        await updateLeadSettings(req.auth!, req.body ?? {}, {
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);
