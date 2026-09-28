const path = require('path')
const { spawn } = require('child_process')
const dotenv = require('dotenv')

const root = path.join(__dirname, '..')
const nodeEnv = process.env.NODE_ENV || 'development'

dotenv.config({ path: path.join(root, '.env') })
dotenv.config({
  path: path.join(root, `.env.${nodeEnv}`),
  override: true,
})

if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL
}

const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
const child = spawn(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
