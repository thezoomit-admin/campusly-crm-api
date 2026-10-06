import type { Response } from 'express'
import ExcelJS from 'exceljs'

export const EXPORT_ROW_CAP = 10000

export type ExportColumn = {
  header: string
  key: string
  width?: number
}

export type TabularExport = {
  title: string
  fileName: string
  columns: ExportColumn[]
  rows: Array<Record<string, string | number>>
}

export function exportFileStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatExportDate(value?: Date | string | null) {
  if (!value) return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number)
    if (year && month && day) {
      return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(year, month - 1, day))
    }
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatExportDateTime(value?: Date | string | null) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function exportCell(value?: string | number | null) {
  if (value == null) return ''
  const text = String(value).trim()
  if (!text || text === '—') return ''
  return text
}

async function workbookBuffer(table: TabularExport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Campusly CRM'
  const sheet = workbook.addWorksheet(table.title.slice(0, 31) || 'Export')
  sheet.columns = table.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 18,
  }))
  for (const row of table.rows) {
    sheet.addRow(row)
  }
  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  if (table.columns.length) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: table.columns.length },
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function respondWithExport(res: Response, format: unknown, table: TabularExport) {
  if (format === 'json') {
    res.json({
      title: table.title,
      columns: table.columns.map((column) => ({ header: column.header, key: column.key })),
      rows: table.rows,
    })
    return
  }

  const buffer = await workbookBuffer(table)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${table.fileName}"`)
  res.send(buffer)
}
