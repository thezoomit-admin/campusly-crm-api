import 'dotenv/config'
import { PrismaClient, type ActivityType, type Prisma } from '../generated/prisma/index'
import { normalizeEmail, normalizeUsername } from '../src/modules/auth/identifier'
import { PERMISSION_CATALOG, ROLE_DEFAULTS } from '../src/modules/auth/permission-catalog'
import { getMasterDataCategory, MASTER_DATA_SEEDS } from '../src/modules/master-data/master-data.catalog'
import { hashPassword } from '../src/modules/auth/password'

const prisma = new PrismaClient()

const ROOT_ADMIN = {
  email: 'admin@campusly.com',
  username: 'root',
  password: '12345678',
  fullName: 'Root Administrator',
  mobile: '01700000001',
}

const departments = [
  { key: 'counselling', name: 'Counselling', description: 'Student counselling and guidance' },
  { key: 'sales', name: 'Sales', description: 'Lead conversion and package sales' },
  { key: 'call_center', name: 'Call Center', description: 'Inbound and outbound calling' },
  { key: 'operations', name: 'Operations', description: 'File processing and documentation' },
]

const teams = [
  { key: 'team_a', name: 'Team A', departmentKey: 'counselling' },
  { key: 'team_b', name: 'Team B', departmentKey: 'counselling' },
  { key: 'canada_team', name: 'Canada Team', departmentKey: 'sales' },
  { key: 'uk_team', name: 'UK Team', departmentKey: 'sales' },
  { key: 'call_team', name: 'Call Team', departmentKey: 'call_center' },
  { key: 'docs_team', name: 'Documents Team', departmentKey: 'operations' },
]

type DemoUserSeed = {
  email: string
  username: string
  fullName: string
  mobile: string
  roleKey: string
  departmentKey: string
  teamKey: string
  designationCode: string
  employeeCode: string
  gender: 'MALE' | 'FEMALE'
  joiningDate: string
}

const DEMO_USERS: DemoUserSeed[] = [
  {
    email: 'ceo@campusly.com',
    username: 'ceo',
    fullName: 'Nadia Rahman',
    mobile: '01710000001',
    roleKey: 'ceo',
    departmentKey: 'operations',
    teamKey: 'docs_team',
    designationCode: 'CEO',
    employeeCode: 'EMP-0002',
    gender: 'FEMALE',
    joiningDate: '2022-01-10',
  },
  {
    email: 'manager@campusly.com',
    username: 'manager',
    fullName: 'Karim Hossain',
    mobile: '01710000002',
    roleKey: 'manager',
    departmentKey: 'counselling',
    teamKey: 'team_a',
    designationCode: 'MANAGER',
    employeeCode: 'EMP-0003',
    gender: 'MALE',
    joiningDate: '2022-06-15',
  },
  {
    email: 'sarah.ahmed@campusly.com',
    username: 'sarah',
    fullName: 'Sarah Ahmed',
    mobile: '01710000003',
    roleKey: 'counsellor',
    departmentKey: 'counselling',
    teamKey: 'team_a',
    designationCode: 'COUNSELLOR',
    employeeCode: 'EMP-0004',
    gender: 'FEMALE',
    joiningDate: '2023-02-01',
  },
  {
    email: 'rafiq.khan@campusly.com',
    username: 'rafiq',
    fullName: 'Rafiq Khan',
    mobile: '01710000004',
    roleKey: 'counsellor',
    departmentKey: 'counselling',
    teamKey: 'team_b',
    designationCode: 'COUNSELLOR',
    employeeCode: 'EMP-0005',
    gender: 'MALE',
    joiningDate: '2023-05-20',
  },
  {
    email: 'call.exec@campusly.com',
    username: 'call.exec',
    fullName: 'Fatima Begum',
    mobile: '01710000005',
    roleKey: 'call_executive',
    departmentKey: 'call_center',
    teamKey: 'call_team',
    designationCode: 'CALL_EXECUTIVE',
    employeeCode: 'EMP-0006',
    gender: 'FEMALE',
    joiningDate: '2024-01-08',
  },
  {
    email: 'imran.ali@campusly.com',
    username: 'imran',
    fullName: 'Imran Ali',
    mobile: '01710000006',
    roleKey: 'call_executive',
    departmentKey: 'call_center',
    teamKey: 'call_team',
    designationCode: 'CALL_EXECUTIVE',
    employeeCode: 'EMP-0007',
    gender: 'MALE',
    joiningDate: '2024-03-12',
  },
  {
    email: 'sales.lead@campusly.com',
    username: 'sales.lead',
    fullName: 'Tanvir Islam',
    mobile: '01710000007',
    roleKey: 'manager',
    departmentKey: 'sales',
    teamKey: 'canada_team',
    designationCode: 'TEAM_LEAD',
    employeeCode: 'EMP-0008',
    gender: 'MALE',
    joiningDate: '2023-09-01',
  },
]

const DEMO_PASSWORD = 'Campusly@123'

function daysAgo(days: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function daysAgoAt(days: number, hours: number, minutes: number) {
  const date = daysAgo(days)
  date.setUTCHours(hours, minutes, 0, 0)
  return date
}

const DEMO_LEAD_PROFILE: Record<
  string,
  {
    email: string
    priority: string
    preferredCourse: string
    englishTestCode: string
    overallScore: number | null
    source: string
    createdAt: Date
  }
> = {
  'L-1001': {
    email: 'ayesha@example.com',
    priority: 'High',
    preferredCourse: 'BSc Computer Science',
    englishTestCode: 'IELTS',
    overallScore: 6.5,
    source: 'Website',
    createdAt: daysAgoAt(0, 10, 24),
  },
  'L-1002': {
    email: 'hasan@example.com',
    priority: 'Medium',
    preferredCourse: 'Business',
    englishTestCode: 'IELTS',
    overallScore: 6,
    source: 'Meta Ads',
    createdAt: daysAgoAt(1, 9, 15),
  },
  'L-1009': {
    email: 'farzana@example.com',
    priority: 'High',
    preferredCourse: 'HSC Waiting',
    englishTestCode: 'SSC 2024',
    overallScore: null,
    source: 'Referral',
    createdAt: daysAgoAt(2, 15, 42),
  },
  'L-1004': {
    email: 'omar@example.com',
    priority: 'Medium',
    preferredCourse: 'Engineering',
    englishTestCode: 'HSC 2023',
    overallScore: null,
    source: 'Website',
    createdAt: daysAgoAt(2, 11, 20),
  },
  'L-1003': {
    email: 'nusrat@example.com',
    priority: 'High',
    preferredCourse: 'BSc in CSE',
    englishTestCode: 'IELTS',
    overallScore: 6.5,
    source: 'WhatsApp',
    createdAt: daysAgoAt(4, 16, 30),
  },
  'L-1010': {
    email: 'rakibul@example.com',
    priority: 'Low',
    preferredCourse: 'Diploma (Completed)',
    englishTestCode: '',
    overallScore: null,
    source: 'Referral',
    createdAt: daysAgoAt(5, 13, 10),
  },
  'L-1005': {
    email: 'mithila@example.com',
    priority: 'Medium',
    preferredCourse: 'BSc in EEE',
    englishTestCode: 'IELTS',
    overallScore: 7,
    source: 'Campaign',
    createdAt: daysAgoAt(6, 8, 52),
  },
  'L-1006': {
    email: 'sabbir@example.com',
    priority: 'High',
    preferredCourse: 'MBA',
    englishTestCode: '',
    overallScore: null,
    source: 'Phone',
    createdAt: daysAgoAt(7, 17, 18),
  },
  'L-1011': {
    email: 'shila@example.com',
    priority: 'Medium',
    preferredCourse: 'BSc in EEE',
    englishTestCode: '',
    overallScore: null,
    source: 'WhatsApp',
    createdAt: daysAgoAt(8, 12, 5),
  },
  'L-1007': {
    email: 'ruma@example.com',
    priority: 'Low',
    preferredCourse: 'Foundation Year',
    englishTestCode: '',
    overallScore: null,
    source: 'Walk-in',
    createdAt: daysAgoAt(9, 9, 40),
  },
}

async function enrichDemoLeads() {
  for (const [code, profile] of Object.entries(DEMO_LEAD_PROFILE)) {
    await prisma.lead.updateMany({
      where: { code, email: null },
      data: {
        email: profile.email,
        priority: profile.priority,
        preferredCourse: profile.preferredCourse,
        englishTestCode: profile.englishTestCode || null,
        overallScore: profile.overallScore,
        source: profile.source,
        createdAt: profile.createdAt,
      },
    })
  }
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

async function alignLeadStatuses() {
  await prisma.masterDataItem.updateMany({
    where: { categoryKey: 'LEAD_STATUS', code: { in: ['INTERESTED', 'OFFER_SENT'] } },
    data: { status: 'INACTIVE' },
  })

  const mappings = [
    { fromNames: ['Interested'], fromCodes: ['INTERESTED'], toCode: 'QUALIFIED' },
    { fromNames: ['Offer Sent'], fromCodes: ['OFFER_SENT'], toCode: 'OFFERED' },
    { fromNames: ['Follow-up', 'Follow Up'], fromCodes: [] as string[], toCode: 'CONTACTED' },
  ]

  for (const mapping of mappings) {
    const target = await prisma.masterDataItem.findUnique({
      where: { categoryKey_code: { categoryKey: 'LEAD_STATUS', code: mapping.toCode } },
    })
    if (!target) continue
    await prisma.lead.updateMany({
      where: {
        OR: [
          ...mapping.fromNames.map((name) => ({ status: { equals: name, mode: 'insensitive' as const } })),
          ...mapping.fromCodes.map((code) => ({ statusCode: code })),
        ],
      },
      data: { status: target.name, statusCode: target.code },
    })
  }

  const statuses = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'LEAD_STATUS', code: { not: null } },
  })
  for (const item of statuses) {
    if (!item.code) continue
    await prisma.lead.updateMany({
      where: { status: { equals: item.name, mode: 'insensitive' }, statusCode: null },
      data: { statusCode: item.code },
    })
  }
}

async function upsertMasterDataSeeds() {
  for (const item of MASTER_DATA_SEEDS) {
    const category = getMasterDataCategory(item.categoryKey)
    const parentCategoryKey = category?.parentCategoryKey
    const parent =
      parentCategoryKey && item.parentCode
        ? await prisma.masterDataItem.findUnique({
            where: { categoryKey_code: { categoryKey: parentCategoryKey, code: item.parentCode } },
          })
        : null

    if (parentCategoryKey && !parent) {
      continue
    }

    await prisma.masterDataItem.upsert({
      where: { categoryKey_code: { categoryKey: item.categoryKey, code: item.code } },
      update: {
        name: item.name,
        nameNormalized: item.name.trim().toLowerCase(),
        description: item.description || null,
        sortOrder: item.sortOrder,
        isSystem: Boolean(item.isSystem),
        behaviorKey: item.behaviorKey || null,
        extras: item.extras ?? undefined,
        parentId: parent?.id ?? null,
        status: 'ACTIVE',
      },
      create: {
        categoryKey: item.categoryKey,
        name: item.name,
        nameNormalized: item.name.trim().toLowerCase(),
        code: item.code,
        description: item.description || null,
        sortOrder: item.sortOrder,
        isSystem: Boolean(item.isSystem),
        behaviorKey: item.behaviorKey || null,
        extras: item.extras ?? undefined,
        parentId: parent?.id ?? null,
      },
    })
  }

  for (const categoryKey of ['LEAD_LOST_REASON', 'LEAD_CLOSE_REASON'] as const) {
    const keep = new Set(MASTER_DATA_SEEDS.filter((item) => item.categoryKey === categoryKey).map((item) => item.code))
    await prisma.masterDataItem.updateMany({
      where: { categoryKey, code: { notIn: [...keep] }, status: 'ACTIVE' },
      data: { status: 'INACTIVE' },
    })
  }
}

async function upsertUserWithEmployee(input: {
  email: string
  username: string
  fullName: string
  mobile: string
  passwordHash: string
  roleId: string
  departmentId: string
  teamId: string | null
  designationId: string
  employmentTypeId: string
  employmentStatusId: string
  employeeCode: string
  gender: 'MALE' | 'FEMALE' | 'OTHER'
  joiningDate: Date
  reportingManagerId?: string | null
  officialEmail?: string
}) {
  const email = normalizeEmail(input.email)
  const username = normalizeUsername(input.username)

  const byEmail = await prisma.user.findUnique({ where: { email } })
  const byUsername = await prisma.user.findUnique({ where: { username } })

  if (byEmail && byUsername && byEmail.id !== byUsername.id) {
    throw new Error(`Cannot seed user: email "${email}" and username "${username}" belong to different accounts`)
  }

  const existing = byEmail || byUsername
  const userData = {
    email,
    username,
    fullName: input.fullName,
    mobile: input.mobile,
    passwordHash: input.passwordHash,
    status: 'ACTIVE' as const,
    failedLoginAttempts: 0,
    lockedUntil: null,
    primaryRoleId: input.roleId,
    departmentId: input.departmentId,
    teamId: input.teamId,
  }

  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: userData })
    : await prisma.user.create({
        data: {
          email,
          username,
          fullName: input.fullName,
          mobile: input.mobile,
          passwordHash: input.passwordHash,
          status: 'ACTIVE',
          primaryRoleId: input.roleId,
          departmentId: input.departmentId,
          teamId: input.teamId,
        },
      })

  const officialEmail = normalizeEmail(input.officialEmail || email)
  const existingEmployee =
    (await prisma.employee.findUnique({ where: { employeeCode: input.employeeCode } })) ||
    (await prisma.employee.findUnique({ where: { userId: user.id } })) ||
    (await prisma.employee.findUnique({ where: { officialEmail } }))

  const employeeData = {
    employeeCode: input.employeeCode,
    fullName: input.fullName,
    gender: input.gender,
    mobile: input.mobile,
    personalEmail: email,
    officialEmail,
    designationId: input.designationId,
    departmentId: input.departmentId,
    teamId: input.teamId,
    roleId: input.roleId,
    employmentTypeId: input.employmentTypeId,
    employmentStatusId: input.employmentStatusId,
    reportingManagerId: input.reportingManagerId ?? null,
    joiningDate: input.joiningDate,
    presentAddress: 'Dhaka, Bangladesh',
    nationality: 'Bangladeshi',
    userId: user.id,
  }

  const employee = existingEmployee
    ? await prisma.employee.update({ where: { id: existingEmployee.id }, data: employeeData })
    : await prisma.employee.create({ data: employeeData })

  return { user, employee }
}

async function seedActivities(userIds: string[]) {
  const existing = await prisma.activity.count()
  if (existing > 0 || userIds.length === 0) {
    return
  }

  const samples: Array<{
    type: ActivityType
    userId: string
    daysAgo: number
    durationMin?: number
    outcome: string
    notes: string
    relatedName: string
    relatedType: string
    nextAction?: string
    nextDays?: number
  }> = [
    {
      type: 'CALL',
      userId: userIds[2] || userIds[0],
      daysAgo: 1,
      durationMin: 18,
      outcome: 'Connected',
      notes: 'Discussed Canada intake options and IELTS requirements.',
      relatedName: 'Ayesha Siddiqua',
      relatedType: 'lead',
      nextAction: 'Send university shortlist',
      nextDays: 1,
    },
    {
      type: 'MEETING',
      userId: userIds[1] || userIds[0],
      daysAgo: 2,
      durationMin: 45,
      outcome: 'Interested',
      notes: 'In-office counselling with student and guardian.',
      relatedName: 'Hasan Mahmud',
      relatedType: 'lead',
      nextAction: 'Collect academic transcripts',
      nextDays: 3,
    },
    {
      type: 'EMAIL',
      userId: userIds[3] || userIds[0],
      daysAgo: 3,
      outcome: 'Sent',
      notes: 'Shared offer letter checklist and fee breakdown.',
      relatedName: 'Nusrat Jahan',
      relatedType: 'lead',
    },
    {
      type: 'MESSAGE',
      userId: userIds[4] || userIds[0],
      daysAgo: 3,
      outcome: 'Replied',
      notes: 'WhatsApp follow-up about May 2027 intake seat availability.',
      relatedName: 'Omar Faruk',
      relatedType: 'lead',
      nextAction: 'Schedule callback',
      nextDays: 1,
    },
    {
      type: 'FOLLOW_UP',
      userId: userIds[5] || userIds[0],
      daysAgo: 4,
      durationMin: 8,
      outcome: 'Call Back Later',
      notes: 'Student requested evening callback after class.',
      relatedName: 'Mithila Chowdhury',
      relatedType: 'lead',
      nextAction: 'Evening call',
      nextDays: 0,
    },
    {
      type: 'NOTE',
      userId: userIds[0],
      daysAgo: 5,
      outcome: 'Internal',
      notes: 'Priority queue updated for hot Canada leads this week.',
      relatedName: 'Canada Pipeline',
      relatedType: 'system',
    },
    {
      type: 'CALL',
      userId: userIds[6] || userIds[0],
      daysAgo: 6,
      durationMin: 12,
      outcome: 'No Answer',
      notes: 'Tried twice; left voicemail regarding document pending list.',
      relatedName: 'Sabbir Ahmed',
      relatedType: 'lead',
      nextAction: 'Retry call',
      nextDays: 1,
    },
    {
      type: 'MEETING',
      userId: userIds[2] || userIds[0],
      daysAgo: 7,
      durationMin: 30,
      outcome: 'Documents reviewed',
      notes: 'Verified passport and HSC transcript scans.',
      relatedName: 'Ruma Akter',
      relatedType: 'lead',
    },
  ]

  await prisma.activity.createMany({
    data: samples.map((item) => ({
      type: item.type,
      userId: item.userId,
      occurredAt: daysAgo(item.daysAgo),
      durationMin: item.durationMin ?? null,
      outcome: item.outcome,
      notes: item.notes,
      relatedName: item.relatedName,
      relatedType: item.relatedType,
      nextAction: item.nextAction ?? null,
      nextDate: item.nextDays == null ? null : daysAgo(-item.nextDays),
    })),
  })
}

async function seedAuditLogs(adminUserId: string, actorIds: string[]) {
  const existing = await prisma.auditLog.count()
  if (existing > 0) {
    return
  }

  const rows: Prisma.AuditLogCreateManyInput[] = [
    {
      userId: adminUserId,
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: adminUserId,
      metadata: { source: 'seed' },
      createdAt: daysAgo(0),
    },
    {
      userId: adminUserId,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: actorIds[1] || adminUserId,
      metadata: { source: 'seed', email: 'manager@campusly.com' },
      createdAt: daysAgo(8),
    },
    {
      userId: adminUserId,
      action: 'EMPLOYEE_CREATED',
      entityType: 'employee',
      entityId: null,
      metadata: { source: 'seed', employeeCode: 'EMP-0003' },
      createdAt: daysAgo(8),
    },
    {
      userId: actorIds[1] || adminUserId,
      action: 'MASTER_DATA_UPDATED',
      entityType: 'master_data',
      metadata: { source: 'seed', categoryKey: 'LEAD_STATUS', name: 'Qualified' },
      createdAt: daysAgo(4),
    },
    {
      userId: actorIds[2] || adminUserId,
      action: 'ACTIVITY_CREATED',
      entityType: 'activity',
      metadata: { source: 'seed', type: 'CALL' },
      createdAt: daysAgo(1),
    },
  ]

  await prisma.auditLog.createMany({ data: rows })
}

async function seedCampaigns(adminId: string) {
  const existing = await prisma.campaign.count()
  if (existing > 0) return

  const campaigns = [
    {
      code: 'CMP-0001',
      name: 'Spring Intake Meta Ads',
      description: 'Facebook & Instagram lead forms for Spring intake.',
      sourceCode: 'META',
      channel: 'Meta',
      status: 'ACTIVE' as const,
      utmSource: 'meta',
      utmMedium: 'cpc',
      utmCampaign: 'spring_intake',
      budget: 50000,
    },
    {
      code: 'CMP-0002',
      name: 'Website Apply Now',
      description: 'Organic website Apply Now / Contact forms.',
      sourceCode: 'WEBSITE',
      channel: 'Website',
      status: 'ACTIVE' as const,
      utmSource: 'website',
      utmMedium: 'organic',
      utmCampaign: 'apply_now',
      budget: null,
    },
    {
      code: 'CMP-0003',
      name: 'WhatsApp Enquiry Drive',
      description: 'Inbound WhatsApp Business enquiries.',
      sourceCode: 'WHATSAPP',
      channel: 'WhatsApp',
      status: 'ACTIVE' as const,
      utmSource: 'whatsapp',
      utmMedium: 'chat',
      utmCampaign: 'wa_enquiry',
      budget: 10000,
    },
  ]

  for (const campaign of campaigns) {
    await prisma.campaign.create({
      data: {
        ...campaign,
        createdById: adminId,
        updatedById: adminId,
      },
    })
  }
}

async function seedPipelineDemo(userIds: string[]) {
  const leadCount = await prisma.lead.count()
  if (leadCount > 0) {
    await enrichDemoLeads()
    return
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true, username: true },
  })
  const byUsername = new Map(users.map((user) => [user.username, user]))
  const pick = (username: string) => byUsername.get(username)

  await prisma.lead.createMany({
    data: [
      { code: 'L-1001', name: 'Ayesha Siddiqua', phone: '01711-445566', email: 'ayesha@example.com', country: 'Canada', source: 'Website', ownerName: pick('sarah')?.fullName || 'Sarah Ahmed', ownerId: pick('sarah')?.id, status: 'New', statusCode: 'NEW', priority: 'High', preferredCourse: 'BSc Computer Science', englishTestCode: 'IELTS', overallScore: 6.5, createdAt: daysAgoAt(0, 10, 24), updatedAt: daysAgo(0) },
      { code: 'L-1002', name: 'Hasan Mahmud', phone: '01822-778899', email: 'hasan@example.com', country: 'UK', source: 'Meta Ads', ownerName: pick('rafiq')?.fullName || 'Rafiq Khan', ownerId: pick('rafiq')?.id, status: 'Contacted', statusCode: 'CONTACTED', priority: 'Medium', preferredCourse: 'Business', englishTestCode: 'IELTS', overallScore: 6, createdAt: daysAgoAt(1, 9, 15), updatedAt: daysAgo(0) },
      { code: 'L-1003', name: 'Nusrat Jahan', phone: '01933-112233', email: 'nusrat@example.com', country: 'Australia', source: 'WhatsApp', ownerName: pick('sarah')?.fullName || 'Sarah Ahmed', ownerId: pick('sarah')?.id, status: 'Counselling', statusCode: 'COUNSELLING', priority: 'High', preferredCourse: 'BSc in CSE', englishTestCode: 'IELTS', overallScore: 6.5, createdAt: daysAgoAt(4, 16, 30), updatedAt: daysAgo(1) },
      { code: 'L-1004', name: 'Omar Faruk', phone: '01655-998877', email: 'omar@example.com', country: 'Canada', source: 'Website', ownerName: pick('call.exec')?.fullName || 'Fatima Begum', ownerId: pick('call.exec')?.id, status: 'Qualified', statusCode: 'QUALIFIED', priority: 'Medium', preferredCourse: 'Engineering', englishTestCode: 'HSC 2023', createdAt: daysAgoAt(2, 11, 20), updatedAt: daysAgo(1) },
      { code: 'L-1005', name: 'Mithila Chowdhury', phone: '01566-334455', email: 'mithila@example.com', country: 'USA', source: 'Campaign', ownerName: pick('imran')?.fullName || 'Imran Ali', ownerId: pick('imran')?.id, status: 'Offered', statusCode: 'OFFERED', priority: 'Medium', preferredCourse: 'BSc in EEE', englishTestCode: 'IELTS', overallScore: 7, createdAt: daysAgoAt(6, 8, 52), updatedAt: daysAgo(2) },
      { code: 'L-1006', name: 'Sabbir Ahmed', phone: '01777-221100', email: 'sabbir@example.com', country: 'Germany', source: 'Phone', ownerName: pick('sales.lead')?.fullName || 'Tanvir Islam', ownerId: pick('sales.lead')?.id, status: 'Contacted', statusCode: 'CONTACTED', priority: 'High', preferredCourse: 'MBA', createdAt: daysAgoAt(7, 17, 18), updatedAt: daysAgo(3) },
      { code: 'L-1007', name: 'Ruma Akter', phone: '01888-667700', email: 'ruma@example.com', country: 'Canada', source: 'Walk-in', ownerName: pick('manager')?.fullName || 'Karim Hossain', ownerId: pick('manager')?.id, status: 'Converted', statusCode: 'CONVERTED', priority: 'Low', preferredCourse: 'Foundation Year', createdAt: daysAgoAt(9, 9, 40), updatedAt: daysAgo(4) },
      { code: 'L-1008', name: 'Tareq Hasan', phone: '01999-445500', email: 'tareq@example.com', country: 'UK', source: 'Meta', ownerName: pick('call.exec')?.fullName || 'Fatima Begum', ownerId: pick('call.exec')?.id, status: 'Lost', statusCode: 'LOST', priority: 'Medium', createdAt: daysAgoAt(10, 11, 0), updatedAt: daysAgo(5) },
      { code: 'L-1009', name: 'Farzana Kabir', phone: '01311-556677', email: 'farzana@example.com', country: 'Canada', source: 'Referral', ownerName: pick('sarah')?.fullName || 'Sarah Ahmed', ownerId: pick('sarah')?.id, status: 'New', statusCode: 'NEW', priority: 'High', preferredCourse: 'HSC Waiting', englishTestCode: 'SSC 2024', createdAt: daysAgoAt(2, 15, 42), updatedAt: daysAgo(0) },
      { code: 'L-1010', name: 'Rakibul Hasan', phone: '01422-889900', email: 'rakibul@example.com', country: 'Australia', source: 'Referral', ownerName: pick('rafiq')?.fullName || 'Rafiq Khan', ownerId: pick('rafiq')?.id, status: 'Contacted', statusCode: 'CONTACTED', priority: 'Low', preferredCourse: 'Diploma (Completed)', createdAt: daysAgoAt(5, 13, 10), updatedAt: daysAgo(2) },
      { code: 'L-1011', name: 'Shila Begum', phone: '01533-667788', email: 'shila@example.com', country: 'UK', source: 'WhatsApp', ownerName: pick('manager')?.fullName || 'Karim Hossain', ownerId: pick('manager')?.id, status: 'Qualified', statusCode: 'QUALIFIED', priority: 'Medium', preferredCourse: 'BSc in EEE', createdAt: daysAgoAt(8, 12, 5), updatedAt: daysAgo(3) },
      { code: 'L-1012', name: 'Nayeem Chowdhury', phone: '01644-112244', email: 'nayeem@example.com', country: 'USA', source: 'Campaign', ownerName: pick('imran')?.fullName || 'Imran Ali', ownerId: pick('imran')?.id, status: 'Counselling', statusCode: 'COUNSELLING', priority: 'Medium', preferredCourse: 'Software Engineering', englishTestCode: 'IELTS', overallScore: 6, createdAt: daysAgoAt(8, 14, 20), updatedAt: daysAgo(4) },
    ],
  })

  await prisma.application.createMany({
    data: [
      { code: 'APP-3001', applicantName: 'Ruma Akter', university: 'University of Toronto', program: 'Computer Science', intake: 'Sep 2027', counsellorName: pick('sarah')?.fullName, counsellorId: pick('sarah')?.id, status: 'In Review', submittedAt: dateOnly('2026-09-12') },
      { code: 'APP-3002', applicantName: 'Mithila Chowdhury', university: 'McGill University', program: 'Business Administration', intake: 'Jan 2027', counsellorName: pick('rafiq')?.fullName, counsellorId: pick('rafiq')?.id, status: 'Submitted', submittedAt: dateOnly('2026-09-10') },
      { code: 'APP-3003', applicantName: 'Hasan Mahmud', university: 'University of Alberta', program: 'Data Analytics', intake: 'May 2027', counsellorName: pick('sarah')?.fullName, counsellorId: pick('sarah')?.id, status: 'Offer Sent', submittedAt: dateOnly('2026-09-05') },
      { code: 'APP-3004', applicantName: 'Omar Faruk', university: 'University of Manchester', program: 'International Business', intake: 'Sep 2027', counsellorName: pick('manager')?.fullName, counsellorId: pick('manager')?.id, status: 'Processing', submittedAt: dateOnly('2026-09-01') },
      { code: 'APP-3005', applicantName: 'Nusrat Jahan', university: 'University of Sydney', program: 'Nursing', intake: 'Jan 2028', counsellorName: pick('sales.lead')?.fullName, counsellorId: pick('sales.lead')?.id, status: 'Draft', submittedAt: null },
      { code: 'APP-3006', applicantName: 'Farzana Kabir', university: 'UBC', program: 'Software Engineering', intake: 'Sep 2027', counsellorName: pick('sarah')?.fullName, counsellorId: pick('sarah')?.id, status: 'Submitted', submittedAt: dateOnly('2026-09-15') },
    ],
  })

  await prisma.student.createMany({
    data: [
      { studentCode: 'STU-2401', name: 'Farhana Islam', destination: 'Canada', program: 'BSc Computer Science', counsellorName: pick('sarah')?.fullName, counsellorId: pick('sarah')?.id, status: 'Enrolled', enrolledAt: dateOnly('2026-01-15') },
      { studentCode: 'STU-2402', name: 'Mehedi Hasan', destination: 'UK', program: 'MSc Data Science', counsellorName: pick('rafiq')?.fullName, counsellorId: pick('rafiq')?.id, status: 'Active', enrolledAt: dateOnly('2025-09-01') },
      { studentCode: 'STU-2403', name: 'Sadia Rahman', destination: 'Australia', program: 'MBA', counsellorName: pick('manager')?.fullName, counsellorId: pick('manager')?.id, status: 'Active', enrolledAt: dateOnly('2025-05-01') },
      { studentCode: 'STU-2404', name: 'Jubayer Alam', destination: 'Canada', program: 'Diploma IT', counsellorName: pick('sales.lead')?.fullName, counsellorId: pick('sales.lead')?.id, status: 'Completed', enrolledAt: dateOnly('2025-01-10') },
      { studentCode: 'STU-2405', name: 'Anika Sultana', destination: 'Germany', program: 'BEng Mechanical', counsellorName: pick('sarah')?.fullName, counsellorId: pick('sarah')?.id, status: 'Active', enrolledAt: dateOnly('2026-05-01') },
    ],
  })

  await prisma.crmDocument.createMany({
    data: [
      { ownerName: 'Ayesha Siddiqua', docType: 'Passport', category: 'Personal', uploadedBy: pick('sarah')?.fullName, uploadedById: pick('sarah')?.id, status: 'Verified', updatedAt: daysAgo(0) },
      { ownerName: 'Hasan Mahmud', docType: 'Transcript', category: 'Academic', uploadedBy: pick('rafiq')?.fullName, uploadedById: pick('rafiq')?.id, status: 'Pending', updatedAt: daysAgo(1) },
      { ownerName: 'Nusrat Jahan', docType: 'IELTS Scorecard', category: 'Language', uploadedBy: pick('sarah')?.fullName, uploadedById: pick('sarah')?.id, status: 'Verified', updatedAt: daysAgo(2) },
      { ownerName: 'Omar Faruk', docType: 'Bank Statement', category: 'Financial', uploadedBy: pick('call.exec')?.fullName, uploadedById: pick('call.exec')?.id, status: 'Rejected', updatedAt: daysAgo(3) },
      { ownerName: 'Mithila Chowdhury', docType: 'Offer Letter', category: 'Application', uploadedBy: pick('manager')?.fullName, uploadedById: pick('manager')?.id, status: 'Pending', updatedAt: daysAgo(4) },
      { ownerName: 'Ruma Akter', docType: 'Degree Certificate', category: 'Academic', uploadedBy: pick('sarah')?.fullName, uploadedById: pick('sarah')?.id, status: 'Verified', updatedAt: daysAgo(5) },
    ],
  })

  await prisma.payment.createMany({
    data: [
      { invoice: 'INV-5012', payerName: 'Ruma Akter', type: 'File Opening', amount: '৳ 15,000', method: 'bKash', status: 'Paid', paidAt: dateOnly('2026-09-20') },
      { invoice: 'INV-5013', payerName: 'Hasan Mahmud', type: 'Service Charge', amount: '৳ 25,000', method: 'Bank Transfer', status: 'Partial', paidAt: dateOnly('2026-09-18') },
      { invoice: 'INV-5014', payerName: 'Nusrat Jahan', type: 'Application Fee', amount: '৳ 8,500', method: 'Nagad', status: 'Pending', paidAt: null },
      { invoice: 'INV-5015', payerName: 'Omar Faruk', type: 'Service Charge', amount: '৳ 30,000', method: 'Cash', status: 'Paid', paidAt: dateOnly('2026-09-12') },
      { invoice: 'INV-5016', payerName: 'Sabbir Ahmed', type: 'Custom Charge', amount: '৳ 5,000', method: 'Card', status: 'Failed', paidAt: dateOnly('2026-09-10') },
      { invoice: 'INV-5017', payerName: 'Farzana Kabir', type: 'File Opening', amount: '৳ 15,000', method: 'Online Payment', status: 'Paid', paidAt: dateOnly('2026-09-21') },
    ],
  })

  const due = (daysFromNow: number, hour: number) => {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + daysFromNow)
    date.setUTCHours(hour, 0, 0, 0)
    return date
  }

  await prisma.followUp.createMany({
    data: [
      { contactName: 'Ayesha Siddiqua', type: 'Call', ownerName: pick('sarah')?.fullName, ownerId: pick('sarah')?.id, dueAt: due(0, 17), priority: 'High', status: 'Due Soon' },
      { contactName: 'Omar Faruk', type: 'WhatsApp', ownerName: pick('call.exec')?.fullName, ownerId: pick('call.exec')?.id, dueAt: due(1, 11), priority: 'Medium', status: 'Pending' },
      { contactName: 'Hasan Mahmud', type: 'Document Collection', ownerName: pick('rafiq')?.fullName, ownerId: pick('rafiq')?.id, dueAt: due(2, 15), priority: 'High', status: 'Pending' },
      { contactName: 'Nusrat Jahan', type: 'Counselling Follow-up', ownerName: pick('manager')?.fullName, ownerId: pick('manager')?.id, dueAt: due(3, 12), priority: 'Medium', status: 'Pending' },
      { contactName: 'Tareq Hasan', type: 'Payment Follow-up', ownerName: pick('sales.lead')?.fullName, ownerId: pick('sales.lead')?.id, dueAt: due(-4, 10), priority: 'High', status: 'Overdue' },
      { contactName: 'Farzana Kabir', type: 'Email', ownerName: pick('sarah')?.fullName, ownerId: pick('sarah')?.id, dueAt: due(1, 16), priority: 'Low', status: 'Pending' },
    ],
  })

  console.log('Seeded pipeline demo: leads, applications, students, documents, payments, follow-ups')
}

async function main() {
  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL || ROOT_ADMIN.email)
  const username = normalizeUsername(process.env.SEED_ADMIN_USERNAME || ROOT_ADMIN.username)
  const password = process.env.SEED_ADMIN_PASSWORD || ROOT_ADMIN.password

  for (const item of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { resource_action: { resource: item.resource, action: item.action } },
      update: { module: item.module, description: item.description },
      create: {
        module: item.module,
        resource: item.resource,
        action: item.action,
        description: item.description,
      },
    })
  }

  const permissionRows = await prisma.permission.findMany()
  const allowedKeys = new Set(PERMISSION_CATALOG.map((item) => `${item.resource}:${item.action}`))
  const staleIds = permissionRows.filter((row) => !allowedKeys.has(`${row.resource}:${row.action}`)).map((row) => row.id)

  if (staleIds.length > 0) {
    await prisma.permission.deleteMany({ where: { id: { in: staleIds } } })
  }

  const permissionByKey = new Map(
    (await prisma.permission.findMany()).map((row) => [`${row.resource}:${row.action}`, row]),
  )

  for (const [key, role] of Object.entries(ROLE_DEFAULTS)) {
    await prisma.role.upsert({
      where: { key },
      update: {
        name: role.name,
        description: role.description,
        isSystem: Boolean(role.isSystem),
        status: 'ACTIVE',
      },
      create: {
        key,
        name: role.name,
        description: role.description,
        isSystem: Boolean(role.isSystem),
        status: 'ACTIVE',
      },
    })
  }

  await prisma.role.updateMany({
    where: { key: { notIn: Object.keys(ROLE_DEFAULTS) } },
    data: { status: 'INACTIVE' },
  })

  for (const [key, role] of Object.entries(ROLE_DEFAULTS)) {
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { key } })
    const keys = role.permissions === 'all' ? [...permissionByKey.keys()] : role.permissions
    const permissionIds = keys
      .map((item) => permissionByKey.get(item)?.id)
      .filter((id): id is string => Boolean(id))

    await prisma.rolePermission.deleteMany({
      where: {
        roleId: roleRow.id,
        permissionId: { notIn: permissionIds },
      },
    })

    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({
        roleId: roleRow.id,
        permissionId,
      })),
      skipDuplicates: true,
    })
  }

  for (const department of departments) {
    await prisma.department.upsert({
      where: { key: department.key },
      update: { name: department.name, description: department.description, status: 'ACTIVE' },
      create: department,
    })
  }

  for (const team of teams) {
    const department = await prisma.department.findUniqueOrThrow({ where: { key: team.departmentKey } })
    await prisma.team.upsert({
      where: { key: team.key },
      update: { name: team.name, departmentId: department.id, status: 'ACTIVE' },
      create: {
        key: team.key,
        name: team.name,
        departmentId: department.id,
      },
    })
  }

  await upsertMasterDataSeeds()
  await alignLeadStatuses()

  const countryTeamMap: Array<{ countryCode: string; teamKey: string }> = [
    { countryCode: 'CA', teamKey: 'canada_team' },
    { countryCode: 'UK', teamKey: 'uk_team' },
    { countryCode: 'AU', teamKey: 'team_a' },
    { countryCode: 'US', teamKey: 'team_b' },
    { countryCode: 'DE', teamKey: 'canada_team' },
  ]
  for (const rule of countryTeamMap) {
    const team = await prisma.team.findUnique({ where: { key: rule.teamKey } })
    if (!team) continue
    await prisma.countryAssignmentRule.upsert({
      where: { countryCode: rule.countryCode },
      update: { teamId: team.id, isActive: true },
      create: { countryCode: rule.countryCode, teamId: team.id, isActive: true },
    })
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'admin' } })
  const operationsDept = await prisma.department.findUniqueOrThrow({ where: { key: 'operations' } })
  const docsTeam = await prisma.team.findUniqueOrThrow({ where: { key: 'docs_team' } })

  const administratorDesignation = await prisma.masterDataItem.findUniqueOrThrow({
    where: { categoryKey_code: { categoryKey: 'DESIGNATION', code: 'ADMINISTRATOR' } },
  })
  const fullTimeType = await prisma.masterDataItem.findUniqueOrThrow({
    where: { categoryKey_code: { categoryKey: 'EMPLOYMENT_TYPE', code: 'FULL_TIME' } },
  })
  const activeStatus = await prisma.masterDataItem.findUniqueOrThrow({
    where: { categoryKey_code: { categoryKey: 'EMPLOYMENT_STATUS', code: 'ACTIVE' } },
  })

  const passwordHash = await hashPassword(password)
  const demoPasswordHash = await hashPassword(DEMO_PASSWORD)

  const { user: admin, employee: adminEmployee } = await upsertUserWithEmployee({
    email,
    username,
    fullName: ROOT_ADMIN.fullName,
    mobile: ROOT_ADMIN.mobile,
    passwordHash,
    roleId: adminRole.id,
    departmentId: operationsDept.id,
    teamId: docsTeam.id,
    designationId: administratorDesignation.id,
    employmentTypeId: fullTimeType.id,
    employmentStatusId: activeStatus.id,
    employeeCode: 'EMP-0001',
    gender: 'MALE',
    joiningDate: dateOnly('2021-01-01'),
  })

  for (const [resource, scope] of Object.entries(ROLE_DEFAULTS.admin.scopes)) {
    await prisma.userDataScope.upsert({
      where: { userId_resource: { userId: admin.id, resource } },
      update: { scope },
      create: { userId: admin.id, resource, scope },
    })
  }

  const roleRows = await prisma.role.findMany()
  const roleByKey = new Map(roleRows.map((row) => [row.key, row]))
  const departmentRows = await prisma.department.findMany()
  const departmentByKey = new Map(departmentRows.map((row) => [row.key, row]))
  const teamRows = await prisma.team.findMany()
  const teamByKey = new Map(teamRows.map((row) => [row.key, row]))
  const designationRows = await prisma.masterDataItem.findMany({ where: { categoryKey: 'DESIGNATION' } })
  const designationByCode = new Map(designationRows.map((row) => [row.code || '', row]))

  const seededUserIds = [admin.id]
  let managerEmployeeId: string | null = null

  for (const demo of DEMO_USERS) {
    const role = roleByKey.get(demo.roleKey)
    const department = departmentByKey.get(demo.departmentKey)
    const team = teamByKey.get(demo.teamKey)
    const designation = designationByCode.get(demo.designationCode)
    if (!role || !department || !team || !designation) {
      continue
    }

    const { user, employee } = await upsertUserWithEmployee({
      email: demo.email,
      username: demo.username,
      fullName: demo.fullName,
      mobile: demo.mobile,
      passwordHash: demoPasswordHash,
      roleId: role.id,
      departmentId: department.id,
      teamId: team.id,
      designationId: designation.id,
      employmentTypeId: fullTimeType.id,
      employmentStatusId: activeStatus.id,
      employeeCode: demo.employeeCode,
      gender: demo.gender,
      joiningDate: dateOnly(demo.joiningDate),
      reportingManagerId: demo.roleKey === 'counsellor' || demo.roleKey === 'call_executive' ? managerEmployeeId : null,
    })

    if (demo.username === 'manager') {
      managerEmployeeId = employee.id
    }

    const defaults = ROLE_DEFAULTS[demo.roleKey]
    if (defaults) {
      for (const [resource, scope] of Object.entries(defaults.scopes)) {
        await prisma.userDataScope.upsert({
          where: { userId_resource: { userId: user.id, resource } },
          update: { scope },
          create: { userId: user.id, resource, scope },
        })
      }
    }

    seededUserIds.push(user.id)
  }

  // Wire counsellor / call executive reports to manager after manager exists
  if (managerEmployeeId) {
    await prisma.employee.updateMany({
      where: {
        employeeCode: { in: ['EMP-0004', 'EMP-0005', 'EMP-0006', 'EMP-0007'] },
        reportingManagerId: null,
      },
      data: { reportingManagerId: managerEmployeeId },
    })
  }

  await prisma.employee.update({
    where: { id: adminEmployee.id },
    data: {
      designationId: administratorDesignation.id,
      roleId: adminRole.id,
    },
  })

  await seedActivities(seededUserIds)
  await seedAuditLogs(admin.id, seededUserIds)
  await seedPipelineDemo(seededUserIds)
  await seedCampaigns(admin.id)

  const permissionCount = await prisma.rolePermission.count({ where: { roleId: adminRole.id } })
  console.log(`Seeded root administrator ${admin.email} (${admin.username})`)
  console.log(`Administrator role permissions: ${permissionCount}`)
  console.log(`Administrator designation isSystem=${administratorDesignation.isSystem} (not deletable)`)
  console.log(`Demo staff password: ${DEMO_PASSWORD}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
