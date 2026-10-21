import { v2 as cloudinary } from 'cloudinary'
import { loadEnv } from '../loadEnv'

loadEnv()

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
})

export const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'education-crm'

export default cloudinary
