import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { httpError } from '../../lib/http-error'

const configuredMb = Number(process.env.FILE_DOCUMENT_MAX_MB || process.env.DOCUMENT_MAX_MB || 10)
export const MAX_FILE_DOCUMENT_BYTES = Math.max(1, Number.isFinite(configuredMb) ? configuredMb : 10) * 1024 * 1024
const FILE_UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads', 'files')

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'])
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png'])

type CloudinaryResourceType = 'image' | 'raw'
type CloudinaryDeliveryType = 'upload' | 'private'

export type StoredFileAsset = {
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
  const fromName = path.extname(originalName || '').toLowerCase()
  if (ALLOWED_EXT.has(fromName)) return fromName
  if (mimeType === 'application/pdf') return '.pdf'
  if (mimeType.includes('png')) return '.png'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg'
  return fromName
}

export function assertFileDocumentUpload(file: Express.Multer.File | undefined) {
  if (!file) {
    throw httpError.invalidUpload('Please select a document.')
  }
  if (!file.buffer?.length || file.size <= 0) {
    throw httpError.invalidUpload('The selected file is invalid.')
  }
  if (file.size > MAX_FILE_DOCUMENT_BYTES) {
    throw httpError.invalidUpload('The uploaded file exceeds the maximum allowed size.')
  }
  const ext = path.extname(file.originalname || '').toLowerCase()
  const mimeOk = ALLOWED_MIME.has(file.mimetype)
  const extOk = ALLOWED_EXT.has(ext)
  if (!mimeOk && !extOk) {
    throw httpError.invalidUpload('This file format is not supported.')
  }
  if (!mimeOk && extOk) {
    if (ext === '.pdf') file.mimetype = 'application/pdf'
    else if (ext === '.png') file.mimetype = 'image/png'
    else file.mimetype = 'image/jpeg'
  }
}

function uploadBuffer(
  file: Express.Multer.File,
  options: { folder: string; public_id: string; resource_type: CloudinaryResourceType; type: CloudinaryDeliveryType },
) {
  return new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload failed.'))
          return
        }
        resolve(result)
      },
    )
    stream.end(file.buffer)
  })
}

export async function saveFileDocumentAsset(fileId: string, file: Express.Multer.File, displayName?: string) {
  assertFileDocumentUpload(file)
  const ext = extensionFor(file.mimetype, file.originalname)
  const trimmedName = displayName?.trim()
  const fileName = trimmedName || file.originalname || `document${ext}`

  if (!cloudinaryConfigured()) {
    const relativeName = `${randomUUID()}${ext}`
    const directory = path.join(FILE_UPLOAD_ROOT, fileId)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, relativeName), file.buffer)
    return {
      fileName,
      mimeType: file.mimetype,
      storageKey: `filelocal:${fileId}/${relativeName}`,
      fileSize: file.size,
    } satisfies StoredFileAsset
  }

  const resourceType: CloudinaryResourceType = file.mimetype.startsWith('image/') ? 'image' : 'raw'
  try {
    const result = await uploadBuffer(file, {
      folder: `${CLOUDINARY_FOLDER}/files/${fileId}/documents`,
      public_id: `doc-${randomUUID()}${resourceType === 'raw' ? ext : ''}`,
      resource_type: resourceType,
      type: 'private',
    })
    return {
      fileName,
      mimeType: file.mimetype,
      storageKey: `${resourceType}:private:${result.public_id}`,
      fileSize: file.size,
    } satisfies StoredFileAsset
  } catch (error) {
    console.error('[file-documents] upload failed:', error)
    throw httpError.invalidUpload('Unable to upload the document. Please try again.')
  }
}

export async function readFileDocumentAsset(storageKey: string) {
  if (storageKey.startsWith('filelocal:')) {
    const relative = storageKey.slice('filelocal:'.length)
    const absolutePath = path.resolve(FILE_UPLOAD_ROOT, relative)
    if (!absolutePath.startsWith(FILE_UPLOAD_ROOT)) {
      throw httpError.notFound('File not found.')
    }
    try {
      return await readFile(absolutePath)
    } catch {
      throw httpError.notFound('File not found.')
    }
  }

  const parts = storageKey.split(':')
  if (parts.length < 3 || (parts[0] !== 'image' && parts[0] !== 'raw')) {
    throw httpError.notFound('File not found.')
  }
  const resourceType = parts[0] as CloudinaryResourceType
  const deliveryType = parts[1] as CloudinaryDeliveryType
  const publicId = parts.slice(2).join(':')
  const url = cloudinary.url(publicId, {
    resource_type: resourceType,
    type: deliveryType,
    sign_url: deliveryType === 'private',
    secure: true,
  })
  const response = await fetch(url)
  if (!response.ok) throw httpError.notFound('File not found.')
  return Buffer.from(await response.arrayBuffer())
}
