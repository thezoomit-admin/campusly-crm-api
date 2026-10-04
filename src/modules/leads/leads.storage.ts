import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { httpError } from '../../lib/http-error'

export const MAX_LEAD_UPLOAD_BYTES = 5 * 1024 * 1024
export const LEAD_UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads', 'leads')

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg'])
const DOCUMENT_TYPES = new Set([
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

type CloudinaryResourceType = 'image' | 'raw'
type CloudinaryDeliveryType = 'upload' | 'private'

export type StoredLeadUpload = {
  fileName: string
  mimeType: string
  storageKey: string
  fileSize: number
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
  if (mimeType === 'application/pdf') return '.pdf'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg'
  if (mimeType.includes('png')) return '.png'
  if (mimeType.includes('webp')) return '.webp'
  if (mimeType.includes('wordprocessingml')) return '.docx'
  if (mimeType === 'application/msword') return '.doc'
  return ''
}

function assertAllowed(file: Express.Multer.File) {
  if (file.size > MAX_LEAD_UPLOAD_BYTES) {
    throw httpError.invalidUpload('Document must be 5 MB or smaller.')
  }
  if (!DOCUMENT_TYPES.has(file.mimetype)) {
    throw httpError.invalidUpload('Document must be a PDF, Word, or image file.')
  }
}

function resourceTypeFor(mimeType: string): CloudinaryResourceType {
  return IMAGE_TYPES.has(mimeType) ? 'image' : 'raw'
}

function leadPrefix(leadId: string) {
  return `${CLOUDINARY_FOLDER}/leads/${leadId}`
}

function leadDir(leadId: string) {
  return path.join(LEAD_UPLOAD_ROOT, leadId, 'documents')
}

function encodeStorageKey(resourceType: CloudinaryResourceType, deliveryType: CloudinaryDeliveryType, publicId: string) {
  return `${resourceType}:${deliveryType}:${publicId}`
}

function encodeLocalStorageKey(leadId: string, relativeName: string) {
  return `local:${leadId}/documents/${relativeName}`
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

async function saveLocalDocument(leadId: string, file: Express.Multer.File, displayName?: string) {
  const ext = extensionFor(file.mimetype, file.originalname)
  const relativeName = `${randomUUID()}${ext}`
  const directory = leadDir(leadId)
  await mkdir(directory, { recursive: true })
  const absolutePath = path.join(directory, relativeName)
  await writeFile(absolutePath, file.buffer)

  const trimmedName = displayName?.trim()
  return {
    fileName: trimmedName || file.originalname || relativeName,
    mimeType: file.mimetype,
    storageKey: encodeLocalStorageKey(leadId, relativeName),
    fileSize: file.size,
  } satisfies StoredLeadUpload
}

async function saveCloudinaryDocument(leadId: string, file: Express.Multer.File, displayName?: string) {
  const resourceType = resourceTypeFor(file.mimetype)
  const ext = extensionFor(file.mimetype, file.originalname)
  try {
    const result = await uploadBuffer(file, {
      folder: `${leadPrefix(leadId)}/documents`,
      public_id: `doc-${randomUUID()}${resourceType === 'raw' ? ext : ''}`,
      resource_type: resourceType,
      type: 'private',
    })

    const trimmedName = displayName?.trim()
    return {
      fileName: trimmedName || file.originalname || result.public_id,
      mimeType: file.mimetype,
      storageKey: encodeStorageKey(resourceType, 'private', result.public_id),
      fileSize: file.size,
    } satisfies StoredLeadUpload
  } catch (error) {
    console.error('Lead document Cloudinary upload failed:', error)
    throw httpError.invalidUpload(
      'Document storage is unavailable. Configure Cloudinary credentials or use local storage.',
    )
  }
}

export async function saveLeadDocument(leadId: string, file: Express.Multer.File, displayName?: string) {
  assertAllowed(file)
  if (!cloudinaryConfigured()) {
    return saveLocalDocument(leadId, file, displayName)
  }
  return saveCloudinaryDocument(leadId, file, displayName)
}

export async function destroyLeadStoredUpload(storageKey: string) {
  const parsed = parseStorageKey(storageKey)
  if (!parsed) return

  if (parsed.kind === 'local') {
    const absolutePath = path.resolve(LEAD_UPLOAD_ROOT, parsed.relativePath)
    if (!absolutePath.startsWith(LEAD_UPLOAD_ROOT)) return
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

export async function readLeadStoredFile(storageKey: string) {
  const parsed = parseStorageKey(storageKey)
  if (!parsed) {
    throw httpError.notFound('File not found.')
  }

  if (parsed.kind === 'local') {
    const absolutePath = path.resolve(LEAD_UPLOAD_ROOT, parsed.relativePath)
    if (!absolutePath.startsWith(LEAD_UPLOAD_ROOT)) {
      throw httpError.notFound('File not found.')
    }
    try {
      return await readFile(absolutePath)
    } catch {
      throw httpError.notFound('File not found.')
    }
  }

  return downloadFromCloudinary(parsed.publicId, parsed.resourceType, parsed.deliveryType)
}
