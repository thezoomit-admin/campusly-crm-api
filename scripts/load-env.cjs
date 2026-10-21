const path = require('path')
const dotenv = require('dotenv')

/**
 * Load `.env`, then `.env.${NODE_ENV}` with override.
 * NODE_ENV comes from the shell. When unset, the mode is development.
 */
function loadEnv(cwd = process.cwd()) {
  dotenv.config({ path: path.join(cwd, '.env') })
  const nodeEnv = process.env.NODE_ENV || 'development'
  dotenv.config({
    path: path.join(cwd, `.env.${nodeEnv}`),
    override: true,
  })
  return nodeEnv
}

module.exports = { loadEnv }
