import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { WEBSITE_FORM_TYPES } from './website-forms'

export const publicWebsiteRouter = Router()

type OptionRow = { code: string; name: string }

async function activeOptions(categoryKey: string): Promise<OptionRow[]> {
  const rows = await prisma.masterDataItem.findMany({
    where: { categoryKey, status: 'ACTIVE', code: { not: null } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { code: true, name: true, extras: true },
  })

  const now = new Date()
  return rows
    .filter((row) => {
      if (!row.code) return false
      if (categoryKey !== 'INTAKE' || !row.extras || typeof row.extras !== 'object') return true
      const extras = row.extras as Record<string, unknown>
      const end =
        (typeof extras.endDate === 'string' && extras.endDate) ||
        (typeof extras.intakeEndDate === 'string' && extras.intakeEndDate) ||
        null
      if (!end) return true
      const endDate = new Date(end)
      return Number.isNaN(endDate.getTime()) || endDate >= now
    })
    .map((row) => ({ code: row.code!, name: row.name }))
}

/**
 * Public dropdown master data for website enquiry forms (CRM-011).
 * No authentication — ACTIVE values only.
 */
publicWebsiteRouter.get('/website-form-options', async (_req, res, next) => {
  try {
    const [countries, intakes, educationLevels, studyLevels] = await Promise.all([
      activeOptions('COUNTRY'),
      activeOptions('INTAKE'),
      activeOptions('EDUCATION_LEVEL'),
      activeOptions('STUDY_LEVEL'),
    ])

    res.json({
      formTypes: WEBSITE_FORM_TYPES.map((item) => ({
        code: item.code,
        name: item.name,
        cta: item.cta,
      })),
      countries,
      intakes,
      educationLevels,
      studyLevels,
      requiredFields: ['name', 'phone', 'preferredCountryCode'],
      optionalFields: [
        'email',
        'whatsapp',
        'whatsappSameAsPhone',
        'currentLocation',
        'currentEducation',
        'preferredIntakeCode',
        'studyLevel',
        'message',
        'campaign',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'landingPageUrl',
        'formName',
        'externalId',
      ],
    })
  } catch (error) {
    next(error)
  }
})
