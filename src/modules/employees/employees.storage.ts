import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { httpError } from '../../lib/http-error'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads', 'employees')

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg'])
const DOCUMENT_TYPES = new Set([
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

export const DOCUMENT_FIELD_MAP = {
  documentNid: 'NID',
  documentPhotograph: 'PHOTOGRAPH',
  documentCv: 'CV',
  documentCertificate: 'EDUCATIONAL_CERTIFICATE',
  documentAppointment: 'APPOINTMENT_LETTER',
  documentJoining: 'JOINING_DOCUMENT',
  documentOther: 'OTHER',
} as const

export type DocumentFieldName = keyof typeof DOCUMENT_FIELD_MAP
type EmployeeDocumentType = (typeof DOCUMENT_FIELD_MAP)[DocumentFieldName]
type CloudinaryResourceType = 'image' | 'raw'
type CloudinaryDeliveryType = 'upload' | 'private'

export type StoredUpload = {
  type: EmployeeDocumentType
  fileName: string
  mimeType: string
  storageKey: string
  fileSize: number
  url: string
}

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim(),
  )
}

function extensionFor(mimeType: string, originalName: string) {
  const fromName = path.extname(originalName).toLowerCase()
  if (fromName && fromName.length <= 8) {
    return fromName
  }
  if (mimeType === 'application/pdf') {
    return '.pdf'
  }
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return '.jpg'
  }
  if (mimeType.includes('png')) {
    return '.png'
  }
  if (mimeType.includes('webp')) {
    return '.webp'
  }
  if (mimeType.includes('wordprocessingml')) {
    return '.docx'
  }
  if (mimeType === 'application/msword') {
    return '.doc'
  }
  return ''
}

function assertAllowed(file: Express.Multer.File, kind: 'image' | 'document', label: string) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw httpError.invalidUpload(`${label} must be 5 MB or smaller.`)
  }
  const allowed = kind === 'image' ? IMAGE_TYPES : DOCUMENT_TYPES
  if (!allowed.has(file.mimetype)) {
    throw httpError.invalidUpload(`${label} must be a valid ${kind === 'image' ? 'JPG, PNG, or WEBP image' : 'PDF, Word, or image file'}.`)
  }
}

function resourceTypeFor(mimeType: string): CloudinaryResourceType {
  return IMAGE_TYPES.has(mimeType) ? 'image' : 'raw'
}

function employeePrefix(employeeId: string) {
  return `${CLOUDINARY_FOLDER}/employees/${employeeId}`
}

function encodeStorageKey(resourceType: CloudinaryResourceType, deliveryType: CloudinaryDeliveryType, publicId: string) {
  return `${resourceType}:${deliveryType}:${publicId}`
}

function encodeLocalStorageKey(employeeId: string, relativeName: string) {
  return `local:${employeeId}/documents/${relativeName}`
}

function parseStorageKey(storageKey: string) {
  if (storageKey.startsWith('local:')) {
    return { kind: 'local' as const, relativePath: storageKey.slice('local:'.length) }
  }
  const parts = storageKey.split(':')
  if (parts.length >= 3 && (parts[0] === 'image' || parts[0] === 'raw') && (parts[1] === 'upload' || parts[1] === 'private')) {
    return {
      kind: 'cloudinary' as const,
      resourceType: parts[0] as CloudinaryResourceType,
      deliveryType: parts[1] as CloudinaryDeliveryType,
      publicId: parts.slice(2).join(':'),
    }
  }
  return null
}

function uploadBuffer(
  file: Express.Multer.File,
  options: {
    folder: string
    public_id: string
    resource_type: CloudinaryResourceType
    type: CloudinaryDeliveryType
    overwrite?: boolean
    invalidate?: boolean
  },
) {
  return new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
      if (error || !result) {
        reject(error || new Error('Cloudinary upload failed.'))
        return
      }
      resolve(result)
    })
    stream.end(file.buffer)
  })
}

async function downloadFromCloudinary(publicId: string, resourceType: CloudinaryResourceType, deliveryType: CloudinaryDeliveryType) {
  const url = cloudinary.url(publicId, {
    resource_type: resourceType,
    type: deliveryType,
    sign_url: deliveryType === 'private',
    secure: true,
  })
  const response = await fetch(url)
  if (!response.ok) {
    throw httpError.notFound('File not found.')
  }
  return Buffer.from(await response.arrayBuffer())
}

export function employeeDir(employeeId: string) {
  return path.join(UPLOAD_ROOT, employeeId)
}

function documentsDir(employeeId: string) {
  return path.join(employeeDir(employeeId), 'documents')
}

async function clearLocalProfileFiles(employeeId: string) {
  const dir = employeeDir(employeeId)
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('profile.'))
      .map((name) => unlink(path.join(dir, name)).catch(() => undefined)),
  )
}

async function saveLocalProfilePhoto(employeeId: string, file: Express.Multer.File) {
  const dir = employeeDir(employeeId)
  await mkdir(dir, { recursive: true })
  await clearLocalProfileFiles(employeeId)
  const ext = extensionFor(file.mimetype, file.originalname) || '.jpg'
  const fileName = `profile${ext}`
  await writeFile(path.join(dir, fileName), file.buffer)
  return {
    storageKey: fileName,
    url: `/api/employees/${employeeId}/photo`,
    mimeType: file.mimetype,
    fileName: file.originalname,
    fileSize: file.size,
  }
}

async function saveCloudinaryProfilePhoto(employeeId: string, file: Express.Multer.File) {
  const result = await uploadBuffer(file, {
    folder: employeePrefix(employeeId),
    public_id: 'profile',
    resource_type: 'image',
    type: 'upload',
    overwrite: true,
    invalidate: true,
  })
  return {
    storageKey: encodeStorageKey('image', 'upload', result.public_id),
    url: result.secure_url,
    mimeType: file.mimetype,
    fileName: file.originalname,
    fileSize: file.size,
  }
}

export async function saveProfilePhoto(employeeId: string, file: Express.Multer.File) {
  assertAllowed(file, 'image', 'Profile photo')

  if (cloudinaryConfigured()) {
    try {
      return await saveCloudinaryProfilePhoto(employeeId, file)
    } catch (error) {
      console.error('Employee photo Cloudinary upload failed, using local storage:', error)
    }
  }

  try {
    return await saveLocalProfilePhoto(employeeId, file)
  } catch (error) {
    console.error('Employee photo local upload failed:', error)
    throw httpError.invalidUpload(
      'Profile photo storage is unavailable. Please try again or contact an administrator.',
    )
  }
}

async function saveLocalDocument(
  employeeId: string,
  file: Express.Multer.File,
  type: EmployeeDocumentType,
): Promise<StoredUpload> {
  const ext = extensionFor(file.mimetype, file.originalname)
  const relativeName = `${type.toLowerCase()}-${randomUUID()}${ext}`
  const directory = documentsDir(employeeId)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, relativeName), file.buffer)

  return {
    type,
    fileName: file.originalname || relativeName,
    mimeType: file.mimetype,
    storageKey: encodeLocalStorageKey(employeeId, relativeName),
    fileSize: file.size,
    url: `/api/employees/${employeeId}/documents`,
  }
}

async function saveCloudinaryDocument(
  employeeId: string,
  file: Express.Multer.File,
  type: EmployeeDocumentType,
): Promise<StoredUpload> {
  const resourceType = resourceTypeFor(file.mimetype)
  const ext = extensionFor(file.mimetype, file.originalname)
  const result = await uploadBuffer(file, {
    folder: `${employeePrefix(employeeId)}/documents`,
    public_id: `${type.toLowerCase()}-${randomUUID()}${resourceType === 'raw' ? ext : ''}`,
    resource_type: resourceType,
    type: 'private',
  })
  return {
    type,
    fileName: file.originalname || result.public_id,
    mimeType: file.mimetype,
    storageKey: encodeStorageKey(resourceType, 'private', result.public_id),
    fileSize: file.size,
    url: result.secure_url,
  }
}

export async function saveDocuments(employeeId: string, files: Partial<Record<DocumentFieldName, Express.Multer.File[]>>) {
  const saved: StoredUpload[] = []

  for (const [field, type] of Object.entries(DOCUMENT_FIELD_MAP) as Array<[DocumentFieldName, EmployeeDocumentType]>) {
    const uploads = files[field] || []
    for (const file of uploads) {
      assertAllowed(file, 'document', file.originalname || type)

      if (cloudinaryConfigured()) {
        try {
          saved.push(await saveCloudinaryDocument(employeeId, file, type))
          continue
        } catch (error) {
          console.error('Employee document Cloudinary upload failed, using local storage:', error)
        }
      }

      try {
        saved.push(await saveLocalDocument(employeeId, file, type))
      } catch (error) {
        console.error('Employee document local upload failed:', error)
        throw httpError.invalidUpload(
          'Document storage is unavailable. Please try again or contact an administrator.',
        )
      }
    }
  }

  return saved
}

export async function destroyStoredUpload(storageKey: string) {
  const parsed = parseStorageKey(storageKey)
  if (!parsed) {
    return
  }

  if (parsed.kind === 'local') {
    const absolutePath = path.resolve(UPLOAD_ROOT, parsed.relativePath)
    if (!absolutePath.startsWith(UPLOAD_ROOT)) {
      return
    }
    await unlink(absolutePath).catch(() => undefined)
    return
  }

  await cloudinary.uploader
    .destroy(parsed.publicId, {
      resource_type: parsed.resourceType,
      type: parsed.deliveryType,
      invalidate: true,
    })
    .catch(() => undefined)
}

async function readLocalProfilePhoto(employeeId: string) {
  const dir = employeeDir(employeeId)
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    throw httpError.notFound('File not found.')
  }
  const fileName = entries.find((name) => name.startsWith('profile.'))
  if (!fileName) {
    throw httpError.notFound('File not found.')
  }
  const absolutePath = path.resolve(dir, fileName)
  if (!absolutePath.startsWith(dir)) {
    throw httpError.notFound('File not found.')
  }
  return readFile(absolutePath)
}

export async function readEmployeeFile(employeeId: string, storageKey: string) {
  if (storageKey.startsWith('http://') || storageKey.startsWith('https://')) {
    const response = await fetch(storageKey)
    if (!response.ok) {
      throw httpError.notFound('File not found.')
    }
    return Buffer.from(await response.arrayBuffer())
  }

  // Local profile photo URL stored as /api/employees/:id/photo
  if (storageKey.startsWith('/api/employees/') && storageKey.endsWith('/photo')) {
    return readLocalProfilePhoto(employeeId)
  }

  const parsed = parseStorageKey(storageKey)
  if (parsed?.kind === 'local') {
    const absolutePath = path.resolve(UPLOAD_ROOT, parsed.relativePath)
    if (!absolutePath.startsWith(UPLOAD_ROOT)) {
      throw httpError.notFound('File not found.')
    }
    try {
      return await readFile(absolutePath)
    } catch {
      throw httpError.notFound('File not found.')
    }
  }

  if (parsed?.kind === 'cloudinary') {
    return downloadFromCloudinary(parsed.publicId, parsed.resourceType, parsed.deliveryType)
  }

  // Legacy relative path under the employee folder (e.g. profile.jpg)
  const absolutePath = path.resolve(employeeDir(employeeId), storageKey)
  if (!absolutePath.startsWith(employeeDir(employeeId))) {
    throw httpError.notFound('File not found.')
  }
  try {
    return await readFile(absolutePath)
  } catch {
    throw httpError.notFound('File not found.')
  }
}

export async function removeEmployeeFiles(employeeId: string) {
  await rm(employeeDir(employeeId), { recursive: true, force: true }).catch(() => undefined)

  if (!cloudinaryConfigured()) {
    return
  }

  const prefix = employeePrefix(employeeId)
  const attempts = [
    { resource_type: 'image' as const, type: 'upload' as const },
    { resource_type: 'image' as const, type: 'private' as const },
    { resource_type: 'raw' as const, type: 'upload' as const },
    { resource_type: 'raw' as const, type: 'private' as const },
  ]

  await Promise.all(
    attempts.map((options) => cloudinary.api.delete_resources_by_prefix(prefix, options).catch(() => undefined)),
  )
  await cloudinary.api.delete_folder(`${prefix}/documents`).catch(() => undefined)
  await cloudinary.api.delete_folder(prefix).catch(() => undefined)
}
