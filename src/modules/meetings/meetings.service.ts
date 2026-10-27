import { httpError } from "../../lib/http-error";
import type { AuthContext } from "../auth/session.service";
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  getFollowUp,
  rescheduleFollowUp,
  type AuditMeta,
} from "../follow-ups/follow-ups.service";

function asAuditMeta(meta: {
  ipAddress?: string | null;
  userAgent?: string | null;
}): AuditMeta {
  return {
    ipAddress: meta.ipAddress ?? undefined,
    userAgent: meta.userAgent ?? undefined,
  };
}

async function assertMeetingFollowUp(auth: AuthContext, id: string) {
  const { followUp } = await getFollowUp(auth, id);
  if (followUp.type !== "Meeting") {
    throw httpError.badRequest(
      "This action is only available for meetings.",
      "NOT_A_MEETING",
    );
  }
  return followUp;
}

/** Schedule a meeting (stored as a Meeting-typed follow-up). */
export async function createMeeting(
  auth: AuthContext,
  body: Record<string, unknown>,
  meta: { ipAddress?: string | null; userAgent?: string | null },
) {
  return createFollowUp(
    auth,
    {
      ...body,
      type: "Meeting",
      purpose: body.purpose || "Other",
      purposeOther:
        body.purposeOther ||
        body.meetingType ||
        body.type ||
        "Scheduled meeting",
    },
    asAuditMeta(meta),
  );
}

export async function completeMeeting(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string | null; userAgent?: string | null },
) {
  await assertMeetingFollowUp(auth, id);
  return completeFollowUp(auth, id, body, asAuditMeta(meta));
}

export async function rescheduleMeeting(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string | null; userAgent?: string | null },
) {
  await assertMeetingFollowUp(auth, id);
  return rescheduleFollowUp(auth, id, body, asAuditMeta(meta));
}

export async function cancelMeeting(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string | null; userAgent?: string | null },
) {
  await assertMeetingFollowUp(auth, id);
  return cancelFollowUp(auth, id, body, asAuditMeta(meta));
}
