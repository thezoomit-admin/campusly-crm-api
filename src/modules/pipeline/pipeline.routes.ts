import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { getDashboardOverview, getReportMetrics } from './dashboard.service'

export const pipelineRouter = Router()

pipelineRouter.use(requireAuth)

pipelineRouter.get('/dashboard', async (req, res, next) => {
  try {
    const now = new Date()
    const year = Number(req.query.year) || now.getUTCFullYear()
    const month = Number(req.query.month) || now.getUTCMonth() + 1
    const data = await getDashboardOverview(year, month)
    res.json(data)
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/follow-up-performance', requirePermission('follow_up:view'), async (req, res, next) => {
  try {
    const { getFollowUpPerformance } = await import('./follow-up-performance.service')
    res.json(
      await getFollowUpPerformance(req.auth!, {
        from: queryString(req.query.from),
        to: queryString(req.query.to),
        ownerId: queryString(req.query.ownerId),
      }),
    )
  } catch (error) {
    next(error)
  }
})

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function daysAgoLabel(date: Date | null | undefined) {
  if (!date) return '—'
  const diffMs = Date.now() - date.getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60)))
    return `${hours}h ago`
  }
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function formatDate(date: Date | null | undefined) {
  if (!date) return '—'
  return date.toISOString().slice(0, 10)
}

function formatDue(date: Date | null | undefined) {
  if (!date) return '—'
  const day = date.toISOString().slice(0, 10)
  const time = date.toISOString().slice(11, 16)
  const today = new Date().toISOString().slice(0, 10)
  if (day === today) return `Today ${time}`
  return `${day} ${time}`
}

pipelineRouter.get('/leads', requirePermission('lead:view'), async (req, res, next) => {
  try {
    const search = queryString(req.query.search)?.toLowerCase()
    const rows = await prisma.lead.findMany({ orderBy: { updatedAt: 'desc' } })
    const items = rows
      .map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        phone: row.phone || '—',
        email: row.email || '—',
        country: row.country || '—',
        source: row.source || '—',
        owner: row.ownerName || '—',
        status: row.status,
        updated: daysAgoLabel(row.updatedAt),
      }))
      .filter((row) => {
        if (!search) return true
        return [row.name, row.phone, row.country, row.source, row.owner, row.status]
          .join(' ')
          .toLowerCase()
          .includes(search)
      })
    res.json({ items, total: items.length })
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/applications', requirePermission('lead:convert'), async (req, res, next) => {
  try {
    const search = queryString(req.query.search)?.toLowerCase()
    const rows = await prisma.application.findMany({ orderBy: { updatedAt: 'desc' } })
    const items = rows
      .map((row) => ({
        id: row.id,
        code: row.code,
        applicant: row.applicantName,
        university: row.university || '—',
        program: row.program || '—',
        intake: row.intake || '—',
        counsellor: row.counsellorName || '—',
        status: row.status,
        submitted: row.submittedAt ? formatDate(row.submittedAt) : '—',
      }))
      .filter((row) => {
        if (!search) return true
        return [row.applicant, row.university, row.program, row.counsellor, row.status]
          .join(' ')
          .toLowerCase()
          .includes(search)
      })
    res.json({ items, total: items.length })
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/students', requirePermission('lead:convert'), async (req, res, next) => {
  try {
    const search = queryString(req.query.search)?.toLowerCase()
    const rows = await prisma.student.findMany({ orderBy: { updatedAt: 'desc' } })
    const items = rows
      .map((row) => ({
        id: row.id,
        studentId: row.studentCode,
        name: row.name,
        destination: row.destination || '—',
        program: row.program || '—',
        counsellor: row.counsellorName || '—',
        status: row.status,
        enrolled: row.enrolledAt
          ? row.enrolledAt.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
          : '—',
      }))
      .filter((row) => {
        if (!search) return true
        return [row.studentId, row.name, row.destination, row.program, row.counsellor]
          .join(' ')
          .toLowerCase()
          .includes(search)
      })
    res.json({ items, total: items.length })
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/documents', requirePermission('document:view'), async (req, res, next) => {
  try {
    const { listGlobalLeadDocuments } = await import('../leads/leads.documents')
    const result = await listGlobalLeadDocuments(req.auth!, {
      search: queryString(req.query.search),
      categoryCode: queryString(req.query.categoryCode) || queryString(req.query.category),
      status: queryString(req.query.status),
      uploadedById: queryString(req.query.uploadedById),
      dateFrom: queryString(req.query.dateFrom),
      dateTo: queryString(req.query.dateTo),
      verified: queryString(req.query.verified),
      expired: queryString(req.query.expired),
      missing: queryString(req.query.missing),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    })
    res.json({
      items: result.items.map((row) => ({
        ...row,
        updated: daysAgoLabel(new Date(row.updated)),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    })
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/payments', requirePermission('payment:view'), async (req, res, next) => {
  try {
    const { listPayments } = await import('../payments/payments.service')
    const result = await listPayments(req.auth!, {
      search: queryString(req.query.search),
      methodCode: queryString(req.query.methodCode),
      status: queryString(req.query.status),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 100,
    })
    res.json({
      items: result.items.map((row) => ({
        id: row.id,
        paymentNumber: row.paymentNumber,
        invoice: row.paymentNumber,
        payer: row.studentName,
        type: row.packageName || 'Service Offer',
        amount: `৳ ${Number(row.amount).toLocaleString('en-BD', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
        method: row.methodName || '—',
        status: row.status,
        date: row.paymentDate,
        receiptNumber: row.receipt?.receiptNumber || null,
        leadCode: row.leadCode,
        transactionRef: row.transactionRef,
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    })
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/follow-ups', requirePermission('follow_up:view'), async (req, res, next) => {
  try {
    const { listFollowUps } = await import('../follow-ups/follow-ups.service')
    res.json(
      await listFollowUps(req.auth!, {
        search: queryString(req.query.search),
        leadId: queryString(req.query.leadId),
        status: queryString(req.query.status),
      }),
    )
  } catch (error) {
    next(error)
  }
})

pipelineRouter.get('/reports', requirePermission('report:view'), async (req, res, next) => {
  try {
    const search = queryString(req.query.search)?.toLowerCase()
    const items = (await getReportMetrics()).filter((row) => {
      if (!search) return true
      return [row.metric, row.period, row.value, row.owner, row.status]
        .join(' ')
        .toLowerCase()
        .includes(search)
    })
    res.json({ items, total: items.length })
  } catch (error) {
    next(error)
  }
})
