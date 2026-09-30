import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { httpError } from '../../lib/http-error'

export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_UPLOAD_ERROR = 'Unable to upload attachment.'

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
])

export const EMAIL_DOC_CATEGORIES = [
  'Passport',
  'Academic Certificate',
  'Transcript',
  'IELTS Certificate',
  'Offer Letter',
  'Payment Receipt',
  'Other',
] as const

export function assertEmailAttachment(file: { mimetype: string; size: number }) {
  const type = file.mimetype.toLowerCase().split(';')[0].trim()
  if (!ALLOWED_TYPES.has(type)) {
    throw httpError.invalidUpload(ATTACHMENT_UPLOAD_ERROR)
  }
  if (file.size > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw httpError.invalidUpload(ATTACHMENT_UPLOAD_ERROR)
  }
}

function resourceTypeFor(mime: string): 'image' | 'raw' {
  return mime.startsWith('image/') ? 'image' : 'raw'
}

export async function storeEmailAttachment(input: {
  threadId: string
  buffer: Buffer
  mimeType: string
  fileName?: string | null
}) {
  const safeName = (input.fileName || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 80)
  try {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${CLOUDINARY_FOLDER}/email/${input.threadId}`,
          resource_type: resourceTypeFor(input.mimeType),
          type: 'upload',
          use_filename: true,
          unique_filename: true,
          filename_override: safeName,
        },
        (error: UploadApiErrorResponse | undefined, uploaded: UploadApiResponse | undefined) => {
          if (error || !uploaded) {
            reject(error || new Error('Cloudinary upload failed.'))
            return
          }
          resolve(uploaded)
        },
      )
      stream.end(input.buffer)
    })
    return {
      url: result.secure_url,
      mimeType: input.mimeType,
      fileName: input.fileName || safeName,
      fileSize: input.buffer.length,
    }
  } catch (error) {
    console.error('[email] attachment upload failed:', error)
    throw httpError.badRequest(ATTACHMENT_UPLOAD_ERROR, 'ATTACHMENT_FAILED')
  }
}
