import { createServer, type Server } from "http";
import app from "./app";
import { config } from "./config";
import { startDocumentExpiryJob } from "./jobs/document-expiry";
import { startEmailInboundSyncJob } from "./jobs/email-inbound-sync";
import { startEmailWaitingReplyJob } from "./jobs/email-waiting-reply";
import { startFollowUpJobs } from "./jobs/follow-up-jobs";
import { startOfferExpiryJob } from "./jobs/offer-expiry";
import { prisma } from "./lib/prisma";
import { ensureLeadAttribution } from "./modules/leads/lead-attribution";
import { ensurePerformanceSetup } from "./modules/performance/performance.service";
import { syncStoredLeadScores } from "./modules/leads/leads.helpers";
import { ensureDocumentChecklistRules } from "./modules/leads/leads.documents";
import { ensureFileDocumentSetup } from "./modules/files/file-documents.service";
import { initSocket } from "./realtime/socket";

const PORT = config.port;
let server: Server | undefined;
let followUpJobTimer: ReturnType<typeof setInterval> | undefined;
let offerExpiryTimer: ReturnType<typeof setInterval> | undefined;
let emailInboundTimer: ReturnType<typeof setInterval> | undefined;
let emailWaitingReplyTimer: ReturnType<typeof setInterval> | undefined;
let documentExpiryTimer: ReturnType<typeof setInterval> | undefined;

const gracefulShutdown = (signal: string) => {
  console.log(`\n🛑 ${signal} received. Starting graceful shutdown...`);

  if (followUpJobTimer) {
    clearInterval(followUpJobTimer);
    followUpJobTimer = undefined;
  }
  if (offerExpiryTimer) {
    clearInterval(offerExpiryTimer);
    offerExpiryTimer = undefined;
  }
  if (emailInboundTimer) {
    clearInterval(emailInboundTimer);
    emailInboundTimer = undefined;
  }
  if (emailWaitingReplyTimer) {
    clearInterval(emailWaitingReplyTimer);
    emailWaitingReplyTimer = undefined;
  }
  if (documentExpiryTimer) {
    clearInterval(documentExpiryTimer);
    documentExpiryTimer = undefined;
  }

  if (server) {
    server.close((err) => {
      if (err) {
        console.error("❌ Error during server shutdown:", err);
        process.exit(1);
      }

      console.log("✅ HTTP server closed successfully");

      prisma
        .$disconnect()
        .then(() => {
          console.log("✅ Database connection closed successfully");
          process.exit(0);
        })
        .catch((error) => {
          console.error("❌ Error closing database connection:", error);
          process.exit(1);
        });
    });
  } else {
    process.exit(0);
  }
};

const exitHandler = (error: Error, event: string) => {
  console.error(`❌ ${event}:`, error);
  gracefulShutdown(event);
};

process.on("uncaughtException", (error: Error) => {
  exitHandler(error, "uncaughtException");
});

process.on("unhandledRejection", (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  exitHandler(error, "unhandledRejection");
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function bootstrap() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected successfully");
    await ensureLeadAttribution().catch((error) => {
      console.error("Lead attribution setup skipped:", error);
    });
    await ensurePerformanceSetup().catch((error) => {
      console.error("Employee performance setup skipped:", error);
    });
    await ensureDocumentChecklistRules().catch((error) => {
      console.error("Document checklist setup skipped:", error);
    });
    await ensureFileDocumentSetup().catch((error) => {
      console.error("File document setup skipped:", error);
    });
    await syncStoredLeadScores()
      .then((updated) => {
        if (updated > 0)
          console.log(`Lead scores refreshed from profile data (${updated})`);
      })
      .catch((error) => {
        console.error("Lead score refresh skipped:", error);
      });

    server = createServer(app);
    initSocket(server);
    server.listen(PORT, "0.0.0.0", () => {
      console.log("🚀 Campusly CRM API Started Successfully!");
      console.log(`📍 Server running on: http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${config.env}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🔌 Socket.IO ready on: http://localhost:${PORT}/socket.io`);
      console.log("─".repeat(60));
      followUpJobTimer = startFollowUpJobs();
      console.log(
        "⏱️  Follow-up jobs started (overdue + reminders, every 1 min)",
      );
      offerExpiryTimer = startOfferExpiryJob();
      emailInboundTimer = startEmailInboundSyncJob();
      emailWaitingReplyTimer = startEmailWaitingReplyJob();
      documentExpiryTimer = startDocumentExpiryJob();
      console.log("⏱️  Document expiry job started (hourly)");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

void bootstrap();
