import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { config } from '../../config'
import { httpError } from '../../lib/http-error'
import type { WhatsAppMessageType } from '../../lib/prisma-client'

export const MAX_WHATSAPP_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
])
const VIDEO_TYPES = new Set(['video/mp4', 'video/3gpp'])
const VOICE_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'])

export const ATTACHMENT_UPLOAD_ERROR = 'Unable to upload attachment.'

export function messageTypeForMime(mime: string): WhatsAppMessageType | null {
  const type = mime.toLowerCase().split(';')[0].trim()
  if (IMAGE_TYPES.has(type) || type.startsWith('image/')) return 'IMAGE'
  if (type === 'application/pdf') return 'PDF'
  if (DOCUMENT_TYPES.has(type)) return 'DOCUMENT'
  if (VIDEO_TYPES.has(type) || type.startsWith('video/')) return 'VIDEO'
  if (VOICE_TYPES.has(type) || type.startsWith('audio/')) return 'VOICE'
  return null
}

export function isMessageTypeEnabled(type: WhatsAppMessageType) {
  if (type === 'VIDEO') return config.whatsapp.allowVideo
  if (type === 'VOICE') return config.whatsapp.allowVoice
  return true
}

export function assertOutgoingAttachment(file: Express.Multer.File) {
  const type = messageTypeForMime(file.mimetype)
  if (!type || !isMessageTypeEnabled(type)) {
    throw httpError.invalidUpload('This file type is not supported for WhatsApp.')
  }
  if (type === 'IMAGE' && !IMAGE_TYPES.has(file.mimetype.toLowerCase())) {
    throw httpError.invalidUpload('Images must be JPG, PNG, or WEBP.')
  }
  const limit = type === 'IMAGE' ? MAX_IMAGE_BYTES : MAX_WHATSAPP_ATTACHMENT_BYTES
  if (file.size > limit) {
    throw httpError.invalidUpload(`Attachment must be ${Math.round(limit / 1024 / 1024)} MB or smaller.`)
  }
  return type
}

function resourceTypeFor(type: WhatsAppMessageType): 'image' | 'video' | 'raw' {
  if (type === 'IMAGE') return 'image'
  if (type === 'VIDEO' || type === 'VOICE') return 'video'
  return 'raw'
}

export async function storeWhatsAppAttachment(input: {
  conversationId: string
  buffer: Buffer
  mimeType: string
  fileName?: string | null
}) {
  const type = messageTypeForMime(input.mimeType) || 'DOCUMENT'
  const safeName = (input.fileName || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 80)

  try {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${CLOUDINARY_FOLDER}/whatsapp/${input.conversationId}`,
          resource_type: resourceTypeFor(type),
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
      type,
    }
  } catch (error) {
    console.error('[whatsapp] attachment upload failed:', error)
    throw httpError.badRequest(ATTACHMENT_UPLOAD_ERROR, 'ATTACHMENT_FAILED')
  }
}
