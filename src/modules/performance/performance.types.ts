export const PERFORMANCE_MESSAGES = {
  noData: 'No performance data available for the selected period.',
  invalidRange: 'Please select a valid date range.',
  invalidEmployee: 'Selected employee is not available.',
  kpi: 'Unable to calculate KPI performance.',
  calculation: 'Unable to calculate performance data.',
  report: 'Unable to load employee performance.',
  permission: 'You are not authorized to view this performance data.',
  server: 'Unable to load performance data. Please try again.',
} as const

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'custom'

export type KpiStatus = 'Exceeded' | 'Achieved' | 'Below Target'

export type PerformanceFilters = {
  preset?: string
  from?: string
  to?: string
  departmentId?: string
  userId?: string
  country?: string
  source?: string
  campaignId?: string
  status?: string
  priority?: string
  scoreMin?: string
  scoreMax?: string
  rankBy?: string
  metric?: string
}

export type KpiDefinition = {
  key: string
  name: string
  target: number
  unit: 'percent' | 'minutes' | 'currency' | 'count'
  higherIsBetter: boolean
  weight: number
  isActive: boolean
  sortOrder: number
}

export type KpiResult = KpiDefinition & {
  actual: number
  status: KpiStatus
}

export type PerformanceMetrics = {
  assigned: number
  accepted: number
  contacted: number
  unreachable: number
  contactRate: number
  avgResponseMinutes: number
  qualified: number
  potential: number
  unqualified: number
  qualificationPending: number
  qualificationRate: number
  counsellingScheduled: number
  counsellingCompleted: number
  counsellingMissed: number
  counsellingRescheduled: number
  offersCreated: number
  offersAccepted: number
  offersRejected: number
  offersPending: number
  offerAcceptanceRate: number
  paymentInitiated: number
  converted: number
  lost: number
  conversionRate: number
  assignedToConversionRate: number
  qualifiedToConversionRate: number
  avgConversionDays: number
  followUpsDue: number
  followUpsCompleted: number
  followUpsOnTime: number
  followUpsOverdue: number
  followUpsMissed: number
  followUpCompletionRate: number
  followUpOnTimeRate: number
  filesOpened: number
  fileOpeningRate: number
  collectionAmount: number
  collectionVisible: boolean
  avgLeadScore: number
  highPriority: number
  mediumPriority: number
  lowPriority: number
  highPriorityAssigned: number
  highPriorityContacted: number
  highPriorityFollowedUp: number
  highPriorityConverted: number
  highPriorityLeads: number
  activeLeads: number
  pendingFollowUps: number
  todaysFollowUps: number
  overdueFollowUps: number
  overallScore: number | null
}

export type BreakdownRow = {
  label: string
  assigned: number
  converted: number
  conversionRate: number
}

export type StatusCount = {
  status: string
  count: number
}

export type HistoryPoint = {
  month: string
  assigned: number
  converted: number
  followUpOnTimeRate: number
}

export type ActivityItem = {
  at: string
  label: string
  leadId: string
  leadCode: string
  leadName: string
}

export type OverdueItem = {
  followUpId: string
  leadId: string
  leadCode: string
  leadName: string
  dueAt: string | null
  status: string
}

export type DrillRow = {
  kind: 'lead' | 'follow_up'
  id: string
  leadId: string
  code: string
  name: string
  country: string
  source: string
  score: number
  service: string
  status: string
  priority: string
  date: string | null
}

export type EmployeePerformanceRow = PerformanceMetrics & {
  userId: string
  employeeId: string | null
  employeeCode: string | null
  name: string
  departmentId: string | null
  departmentName: string
  kpis: KpiResult[]
}

export type RankRow = {
  userId: string
  name: string
  value: number
  rank: number
}

export type PerformanceOptions = {
  employees: Array<{ userId: string; name: string; departmentId: string | null; departmentName: string }>
  departments: Array<{ id: string; name: string }>
  countries: string[]
  sources: string[]
  campaigns: Array<{ id: string; name: string }>
  statuses: string[]
  priorities: string[]
}

export type PerformanceListResponse = {
  from: string
  to: string
  preset: DatePreset
  message: string | null
  summary: PerformanceMetrics
  employees: EmployeePerformanceRow[]
  ranking: Array<{ key: string; label: string; higherIsBetter: boolean; rows: RankRow[] }>
  kpis: KpiResult[]
  overallScoreEnabled: boolean
  options: PerformanceOptions
}

export type PerformanceDetailResponse = {
  from: string
  to: string
  preset: DatePreset
  message: string | null
  employee: {
    userId: string
    employeeId: string | null
    employeeCode: string | null
    name: string
    departmentId: string | null
    departmentName: string
  }
  metrics: PerformanceMetrics
  kpis: KpiResult[]
  overallScoreEnabled: boolean
  statusBreakdown: StatusCount[]
  countries: BreakdownRow[]
  sources: BreakdownRow[]
  campaigns: BreakdownRow[]
  history: HistoryPoint[]
  recentActivity: ActivityItem[]
  overdue: OverdueItem[]
}
