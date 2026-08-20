import { beforeAll, describe, expect, it } from 'vitest'
import { harness, migrate } from '../fixtures/harness'

beforeAll(migrate)

describe('http surface', () => {
  it('serves health', async () => {
    const res = await harness().get('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('generates an OpenAPI document from the same schemas that validate', async () => {
    const res = await harness().get('/openapi.json')
    expect(res.status).toBe(200)

    const doc = (await res.json()) as { paths: Record<string, unknown>; info: { title: string } }
    expect(doc.info.title).toBe('sebp API')

    // Every route the frontend generates its client from must be present.
    for (const path of [
      '/api/v1/auth/request-otp',
      '/api/v1/auth/complete-signup',
      '/api/v1/auth/sign-in',
      '/api/v1/auth/reset-password',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path)
    }
  })

  it('serves Swagger UI when enabled', async () => {
    const res = await harness().get('/docs')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('swagger')
  })

  it('reflects the configured CORS origin', async () => {
    const res = await harness().get('/api/v1/auth/request-otp', {
      Origin: 'http://localhost:3000',
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    // Credentials must be allowed: the session is a cookie.
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('does not reflect an origin that is not configured', async () => {
    const res = await harness().get('/api/v1/auth/request-otp', {
      Origin: 'https://evil.example.com',
    })
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com')
  })
})
