import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary'
import cloudinary, { CLOUDINARY_FOLDER } from '../../config/cloudinary'
import { httpError } from '../../lib/http-error'

export const MAX_USER_PHOTO_BYTES = 5 * 1024 * 1024
export const USER_UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads', 'users')

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg'])

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
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg'
  if (mimeType.includes('png')) return '.png'
  if (mimeType.includes('webp')) return '.webp'
  return '.jpg'
}

function assertAllowed(file: Express.Multer.File) {
  if (file.size > MAX_USER_PHOTO_BYTES) {
    throw httpError.invalidUpload('Profile photo must be 5 MB or smaller.')
  }
  if (!IMAGE_TYPES.has(file.mimetype)) {
    throw httpError.invalidUpload('Profile photo must be a JPG, PNG, or WEBP image.')
  }
}

function userDir(userId: string) {
  return path.join(USER_UPLOAD_ROOT, userId)
}

async function clearLocalProfileFiles(userId: string) {
  const dir = userDir(userId)
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

async function saveLocalPhoto(userId: string, file: Express.Multer.File) {
  const dir = userDir(userId)
  await mkdir(dir, { recursive: true })
  await clearLocalProfileFiles(userId)
  const ext = extensionFor(file.mimetype, file.originalname)
  const fileName = `profile${ext}`
  await writeFile(path.join(dir, fileName), file.buffer)
  return {
    url: `/api/users/${userId}/photo`,
    mimeType: file.mimetype,
    fileName: file.originalname,
    fileSize: file.size,
  }
}

async function saveCloudinaryPhoto(userId: string, file: Express.Multer.File) {
  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${CLOUDINARY_FOLDER}/users/${userId}`,
        public_id: 'profile',
        resource_type: 'image',
        type: 'upload',
        overwrite: true,
        invalidate: true,
      },
      (error: UploadApiErrorResponse | undefined, uploaded: UploadApiResponse | undefined) => {
        if (error || !uploaded) {
          reject(error || new Error('Cloudinary upload failed.'))
          return
        }
        resolve(uploaded)
      },
    )
    stream.end(file.buffer)
  })

  return {
    url: result.secure_url,
    mimeType: file.mimetype,
    fileName: file.originalname,
    fileSize: file.size,
  }
}

export async function saveUserProfilePhoto(userId: string, file: Express.Multer.File) {
  assertAllowed(file)

  if (cloudinaryConfigured()) {
    try {
      return await saveCloudinaryPhoto(userId, file)
    } catch (error) {
      console.error('User photo Cloudinary upload failed, using local storage:', error)
    }
  }

  try {
    return await saveLocalPhoto(userId, file)
  } catch (error) {
    console.error('User photo local upload failed:', error)
    throw httpError.invalidUpload(
      'Profile photo storage is unavailable. Please try again or contact an administrator.',
    )
  }
}

export async function readUserProfilePhoto(userId: string, photoUrl: string | null) {
  if (!photoUrl) {
    throw httpError.notFound('Profile photo not found.')
  }

  if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) {
    const response = await fetch(photoUrl)
    if (!response.ok) {
      throw httpError.notFound('Profile photo not found.')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    return { buffer, contentType, fileName: `user-${userId}-profile` }
  }

  const dir = userDir(userId)
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    throw httpError.notFound('Profile photo not found.')
  }

  const fileName = entries.find((name) => name.startsWith('profile.'))
  if (!fileName) {
    throw httpError.notFound('Profile photo not found.')
  }

  const absolutePath = path.resolve(dir, fileName)
  if (!absolutePath.startsWith(dir)) {
    throw httpError.notFound('Profile photo not found.')
  }

  const buffer = await readFile(absolutePath)
  const ext = path.extname(fileName).toLowerCase()
  const contentType =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'

  return { buffer, contentType, fileName }
}
