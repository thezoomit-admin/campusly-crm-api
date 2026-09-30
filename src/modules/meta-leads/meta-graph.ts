import { config } from '../../config'

export async function fetchMetaLeadgen(leadgenId: string) {
  const token = config.meta.pageAccessToken
  if (!token) return null
  const url = new URL(`https://graph.facebook.com/${config.meta.graphVersion}/${leadgenId}`)
  url.searchParams.set(
    'fields',
    'id,created_time,field_data,campaign_name,campaign_id,adset_name,ad_name,platform,form_id',
  )
  url.searchParams.set('access_token', token)
  const response = await fetch(url)
  if (!response.ok) return null
  const payload = (await response.json()) as Record<string, unknown>
  return payload
}
