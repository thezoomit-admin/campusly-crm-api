import dotenv from 'dotenv'
import path from 'path'

/**
 * Load `.env`, then `.env.${NODE_ENV}` with override.
 * NODE_ENV comes from the shell (npm scripts). It is not read from these files.
 * When unset, the mode is development.
 */
export function loadEnv(cwd = process.cwd()) {
  dotenv.config({ path: path.join(cwd, '.env') })
  const nodeEnv = process.env.NODE_ENV || 'development'
  dotenv.config({
    path: path.join(cwd, `.env.${nodeEnv}`),
    override: true,
  })
  return nodeEnv
}
