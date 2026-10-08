import { Router } from "express";
import multer from "multer";
import { httpError } from "../../lib/http-error";
import { writeAuditLog } from "../../lib/audit";
import { requestIp, requestUserAgent, routeParam } from "../../lib/request";
import { respondWithExport } from "../../lib/xlsx-export";
import {
  requireAuth,
  requirePermission,
} from "../auth/require-auth.middleware";
import {
  assignLead,
  checkDuplicate,
  closeLead,
  createLead,
  createLeadFollowUp,
  getLead,
  listLeadAssignees,
  listLeadAssignments,
  listLeadPool,
  exportLeadRows,
  listLeads,
  listLeadStatusHistory,
  listMyLeads,
  reopenLead,
  reviewDuplicateLead,
  updateLead,
  updateLeadStatus,
  updatePriority,
  updateQualification,
} from "./leads.service";
import {
  correctLeadCampaign,
  correctLeadSource,
  listAttributionChanges,
} from "./lead-attribution";
import {
  archiveLeadDocument,
  deleteLeadDocument,
  getLeadDocumentChecklist,
  getLeadDocumentFile,
  getLeadDocumentHistory,
  listLeadDocuments,
  rejectLeadDocument,
  uploadLeadDocument,
  verifyLeadDocument,
} from "./leads.documents";
import { createLeadNote, listLeadNotes } from "./leads.notes";
import { handoverLead } from "./leads.handover";
import { previewCountryAssignment } from "./leads.assignment";
import { MAX_LEAD_UPLOAD_BYTES } from "./leads.storage";

export const leadsRouter = Router();

leadsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LEAD_UPLOAD_BYTES },
});

function queryString(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}

function queryNumber(value: unknown) {
  const num =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === "object" ? req.body : {}) as Record<
    string,
    unknown
  >;
}

leadsRouter.post(
  "/duplicate-check",
  requirePermission("lead:create"),
  async (req, res, next) => {
    try {
      res.json(await checkDuplicate(req.auth!, body(req)));
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get("/", requirePermission("lead:view"), async (req, res, next) => {
  try {
    res.json(
      await listLeads(req.auth!, {
        search: queryString(req.query.search),
        page: queryNumber(req.query.page),
        limit: queryNumber(req.query.limit),
        status: queryString(req.query.status),
        source: queryString(req.query.source),
        priority: queryString(req.query.priority),
        country: queryString(req.query.country),
        duplicatesOnly:
          req.query.duplicatesOnly === "1" ||
          req.query.duplicatesOnly === "true" ||
          req.query.duplicatesOnly === "on",
      }),
    );
  } catch (error) {
    next(error);
  }
});

leadsRouter.post(
  "/",
  requirePermission("lead:create"),
  async (req, res, next) => {
    try {
      const result = await createLead(req.auth!, body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/mine",
  requirePermission(
    "lead:view",
    "You do not have permission to access this page.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await listMyLeads(req.auth!, {
          search: queryString(req.query.search),
          page: queryNumber(req.query.page),
          limit: queryNumber(req.query.limit),
          status: queryString(req.query.status),
          source: queryString(req.query.source),
          priority: queryString(req.query.priority),
          country: queryString(req.query.country),
          followUpStatus: queryString(req.query.followUpStatus),
          sort: queryString(req.query.sort),
          order: queryString(req.query.order),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/pool",
  requirePermission(
    "lead:assign",
    "You do not have permission to access the Lead Pool.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await listLeadPool(req.auth!, {
          search: queryString(req.query.search),
          page: queryNumber(req.query.page),
          limit: queryNumber(req.query.limit),
          source: queryString(req.query.source),
          country: queryString(req.query.country),
          createdFrom: queryString(req.query.createdFrom),
          createdTo: queryString(req.query.createdTo),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/assignees",
  requirePermission([
    "lead:assign",
    "lead:reassign",
    "lead:reopen",
    "lead:handover",
  ]),
  async (req, res, next) => {
    try {
      res.json(
        await listLeadAssignees(req.auth!, {
          teamId: queryString(req.query.teamId),
          search: queryString(req.query.search),
          role: queryString(req.query.role),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/assignment-preview",
  requirePermission(["lead:create", "lead:edit"]),
  async (req, res, next) => {
    try {
      const countryCode = queryString(req.query.countryCode) || null;
      res.json({ assignment: await previewCountryAssignment(countryCode) });
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/export",
  requirePermission("lead:export"),
  async (req, res, next) => {
    try {
      const table = await exportLeadRows(req.auth!, {
        search: queryString(req.query.search),
        status: queryString(req.query.status),
        source: queryString(req.query.source),
        priority: queryString(req.query.priority),
        country: queryString(req.query.country),
        duplicatesOnly:
          req.query.duplicatesOnly === "1" ||
          req.query.duplicatesOnly === "true" ||
          req.query.duplicatesOnly === "on",
      });
      await writeAuditLog({
        userId: req.auth!.user.id,
        action: "LEADS_EXPORTED",
        entityType: "lead",
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
        metadata: {
          format: req.query.format === "json" ? "json" : "xlsx",
          count: table.rows.length,
        },
      });
      await respondWithExport(res, req.query.format, table);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id",
  requirePermission("lead:view"),
  async (req, res, next) => {
    try {
      res.json(await getLead(req.auth!, routeParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/status-history",
  requirePermission("lead:view"),
  async (req, res, next) => {
    try {
      res.json(
        await listLeadStatusHistory(req.auth!, routeParam(req.params.id)),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/assignments",
  requirePermission("lead:view"),
  async (req, res, next) => {
    try {
      res.json(await listLeadAssignments(req.auth!, routeParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/notes",
  requirePermission("lead:view"),
  async (req, res, next) => {
    try {
      res.json(await listLeadNotes(req.auth!, routeParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/notes",
  requirePermission("lead:edit"),
  async (req, res, next) => {
    try {
      const result = await createLeadNote(
        req.auth!,
        routeParam(req.params.id),
        body(req),
        {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        },
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/documents",
  requirePermission(["document:view", "lead:view"]),
  async (req, res, next) => {
    try {
      res.json(
        await listLeadDocuments(req.auth!, routeParam(req.params.id), {
          archived: req.query.archived === "1" || req.query.archived === "true",
          includeHistory:
            req.query.includeHistory === "1" ||
            req.query.includeHistory === "true",
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/documents/checklist",
  requirePermission(["document:view", "lead:view"]),
  async (req, res, next) => {
    try {
      res.json(
        await getLeadDocumentChecklist(req.auth!, routeParam(req.params.id)),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/documents",
  requirePermission("document:upload"),
  (req, res, next) => {
    upload.single("file")(req, res, (error: unknown) => {
      if (error) {
        next(httpError.invalidUpload("File size exceeds the allowed limit."));
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const result = await uploadLeadDocument(
        req.auth!,
        routeParam(req.params.id),
        req.file,
        body(req),
        {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        },
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/documents/:documentId/history",
  requirePermission(["document:view", "lead:view"]),
  async (req, res, next) => {
    try {
      res.json(
        await getLeadDocumentHistory(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/documents/:documentId/verify",
  requirePermission("document:verify"),
  async (req, res, next) => {
    try {
      res.json(
        await verifyLeadDocument(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
          body(req),
          { ipAddress: requestIp(req), userAgent: requestUserAgent(req) },
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/documents/:documentId/reject",
  requirePermission("document:verify"),
  async (req, res, next) => {
    try {
      res.json(
        await rejectLeadDocument(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
          body(req),
          { ipAddress: requestIp(req), userAgent: requestUserAgent(req) },
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/documents/:documentId/archive",
  requirePermission("document:delete"),
  async (req, res, next) => {
    try {
      res.json(
        await archiveLeadDocument(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
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

leadsRouter.get(
  "/:id/documents/:documentId",
  requirePermission(["document:download", "document:view", "document:upload"]),
  async (req, res, next) => {
    try {
      const download =
        req.query.download === "1" || req.query.download === "true";
      const file = await getLeadDocumentFile(
        req.auth!,
        routeParam(req.params.id),
        routeParam(req.params.documentId),
        {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
          mode: download ? "download" : "view",
        },
      );
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader(
        "Content-Disposition",
        `${download ? "attachment" : "inline"}; filename="${file.fileName.replace(/"/g, "")}"`,
      );
      res.send(file.buffer);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.delete(
  "/:id/documents/:documentId",
  requirePermission("document:delete"),
  async (req, res, next) => {
    try {
      res.json(
        await deleteLeadDocument(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
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

leadsRouter.post(
  "/:id/handover",
  requirePermission(
    "lead:handover",
    "You do not have permission to access this lead's workspace.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await handoverLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.patch(
  "/:id/assign",
  requirePermission(["lead:assign", "lead:reassign"]),
  async (req, res, next) => {
    try {
      res.json(
        await assignLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.patch(
  "/:id/status",
  requirePermission(
    "lead:update_status",
    "You do not have permission to update the status.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await updateLeadStatus(
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

leadsRouter.patch(
  "/:id/close",
  requirePermission(
    "lead:close",
    "You do not have permission to close or reopen this lead.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await closeLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.patch(
  "/:id/reopen",
  requirePermission(
    "lead:reopen",
    "You do not have permission to close or reopen this lead.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await reopenLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/duplicate-review",
  requirePermission(
    "lead:manage_duplicate",
    "You do not have permission to review duplicate leads.",
  ),
  async (req, res, next) => {
    try {
      const result = await reviewDuplicateLead(
        req.auth!,
        routeParam(req.params.id),
        body(req),
        {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        },
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.get(
  "/:id/attribution-changes",
  requirePermission("lead:view"),
  async (req, res, next) => {
    try {
      res.json(
        await listAttributionChanges(req.auth!, routeParam(req.params.id)),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/source-correction",
  requirePermission(
    "lead:change_source",
    "You are not authorized to change the lead source.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await correctLeadSource(
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

leadsRouter.post(
  "/:id/campaign-correction",
  requirePermission(
    ["lead:change_source", "campaign:manage"],
    "You are not authorized to change the lead source.",
  ),
  async (req, res, next) => {
    try {
      res.json(
        await correctLeadCampaign(
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

leadsRouter.patch(
  "/:id",
  requirePermission("lead:edit"),
  async (req, res, next) => {
    try {
      res.json(
        await updateLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.patch(
  "/:id/qualification",
  requirePermission("lead:qualify"),
  async (req, res, next) => {
    try {
      res.json(
        await updateQualification(
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

leadsRouter.patch(
  "/:id/priority",
  requirePermission("lead:override_priority"),
  async (req, res, next) => {
    try {
      res.json(
        await updatePriority(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

leadsRouter.post(
  "/:id/follow-ups",
  requirePermission("follow_up:create"),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await createLeadFollowUp(
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
