/**
 * SendLetter for Node.
 *
 * Written by hand rather than generated. The API is seven operations, and a
 * generated client for seven operations is a folder of `DefaultApi` classes
 * and `V1LettersPostRequest` types that nobody enjoys reading. This is one
 * file, it has no build-time dependency on a Java toolchain, and it can carry
 * the thing an integrator actually needs and a generator never emits: a
 * webhook verifier.
 *
 * Everything is typed against the same OpenAPI description the server serves
 * at /api/v1/openapi.json, and the tests hold the two together.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const VERSION = '1.0.0'

const DEFAULT_BASE_URL = 'https://onlinebriefversturen.nl'

export type Product = 'standard' | 'priority' | 'registered'
export type LetterMode = 'test' | 'live'

export interface Address {
  company?: string
  name: string
  street: string
  /** House number, separate from the street: some countries print it first. */
  number: string
  addition?: string
  postalCode: string
  city: string
  /** Required for Italy and Spain, ignored elsewhere. */
  province?: string
  /** ISO 3166-1 alpha-2, for example NL. */
  country: string
}

export interface TimelineEntry {
  status: string
  message: string | null
  at: string
}

export interface Letter {
  id: string
  mode: LetterMode
  status: string
  statusDetail: string | null
  pages: number
  sheets: number
  destination: string
  product: string
  colour: boolean
  duplex: boolean
  /** Excluding VAT. */
  priceCents: number
  vatCents: number
  /** Including VAT. This is what is charged. */
  totalCents: number
  currency: string
  trackingCode: string | null
  createdAt: string
  postedAt: string | null
  timeline?: TimelineEntry[]
}

export interface SendLetterInput {
  /** Exactly one of these four. Sending two is refused rather than guessed at. */
  text?: string
  document?: unknown
  file?: { name?: string; contentBase64: string }
  fileUrl?: string

  subject?: string
  locale?: 'nl' | 'en' | 'de' | 'fr' | 'es' | 'it'
  sender: Address
  recipient: Address
  product?: Product
  colour?: boolean
  duplex?: boolean
  /**
   * Repeat a call with the same key and the original letter comes back
   * instead of a second envelope. Send one on anything that can be retried,
   * which on an automation platform is everything.
   */
  idempotencyKey?: string
}

export interface ListLettersOptions {
  limit?: number
  status?: string
  /** Cursor from the previous page's `nextCursor`. */
  before?: string
  /** Leave test letters out of a production list. */
  mode?: LetterMode
}

export interface AddressCheck {
  valid: boolean
  /** False when we do not carry to that country at all, which is not fixable. */
  supported: boolean
  normalised: Address
  lines: string[]
  problems: { field: string; code: string; message: string }[]
  maxSheets: number
}

export interface Quote {
  priceCents: number
  vatCents: number
  totalCents: number
  currency: string
  pages: number
  sheets: number
  availableProducts: Product[]
  breakdown: { printingCents: number; postageCents: number; serviceCents: number }
}

/**
 * Anything the API refused.
 *
 * `code` is the machine readable half and is what to branch on. The ones worth
 * handling by name are `insufficient_balance`, which carries a `topUpUrl` you
 * can put in front of the customer, and `rate_limited`, which carries the
 * seconds to wait.
 */
export class SendLetterError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SendLetterError'
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }

  /** Seconds to wait, when the API said. */
  get retryAfter(): number | undefined {
    const value = this.details?.windowSeconds
    return typeof value === 'number' ? value : undefined
  }

  /** A Stripe checkout for the shortfall, on `insufficient_balance`. */
  get topUpUrl(): string | undefined {
    const value = this.details?.topUpUrl
    return typeof value === 'string' ? value : undefined
  }
}

export interface ClientOptions {
  apiKey: string
  /** Override for the EU domain, a preview deployment or a local server. */
  baseUrl?: string
  /** Per request, in milliseconds. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export class SendLetter {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly doFetch: typeof globalThis.fetch

  constructor(options: ClientOptions | string) {
    const opts = typeof options === 'string' ? { apiKey: options } : options
    if (!opts.apiKey) throw new Error('An API key is required')

    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.doFetch = opts.fetch ?? globalThis.fetch
  }

  /** True when this key posts nothing and charges nothing. */
  get isTestMode(): boolean {
    return this.apiKey.startsWith('sk_test_') || this.apiKey.startsWith('obv_test_')
  }

  async send(input: SendLetterInput): Promise<Letter> {
    return this.request<Letter>('POST', '/api/v1/letters', input)
  }

  async get(letterId: string): Promise<Letter> {
    return this.request<Letter>('GET', `/api/v1/letters/${encodeURIComponent(letterId)}`)
  }

  async list(
    options: ListLettersOptions = {},
  ): Promise<{ data: Letter[]; nextCursor: string | null }> {
    const query = new URLSearchParams()
    if (options.limit) query.set('limit', String(options.limit))
    if (options.status) query.set('status', options.status)
    if (options.before) query.set('before', options.before)
    if (options.mode) query.set('mode', options.mode)
    const suffix = query.toString() ? `?${query}` : ''
    return this.request('GET', `/api/v1/letters${suffix}`)
  }

  /** Walks every page, so a caller does not have to hold the cursor. */
  async *all(options: Omit<ListLettersOptions, 'before'> = {}): AsyncGenerator<Letter> {
    let before: string | undefined
    for (;;) {
      const page = await this.list({ ...options, before })
      for (const letter of page.data) yield letter
      if (!page.nextCursor) return
      before = page.nextCursor
    }
  }

  async cancel(letterId: string, reason?: string): Promise<Letter & { refunded: boolean }> {
    return this.request(
      'POST',
      `/api/v1/letters/${encodeURIComponent(letterId)}/cancel`,
      reason ? { reason } : {},
    )
  }

  /** The letter as printed, or the proof of posting with `{ proof: true }`. */
  async download(letterId: string, options: { proof?: boolean } = {}): Promise<Uint8Array> {
    const suffix = options.proof ? '?proof=1' : ''
    const res = await this.raw(
      'GET',
      `/api/v1/letters/${encodeURIComponent(letterId)}/pdf${suffix}`,
    )
    if (!res.ok) throw await this.toError(res)
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * Checks an address without sending to it.
   *
   * Answers rather than throws when the address is wrong: read `valid`. A bad
   * address is the successful outcome of asking, and a thrown error would make
   * an automation platform retry it forever.
   */
  async validateAddress(address: Address): Promise<AddressCheck> {
    return this.request<AddressCheck>('POST', '/api/v1/addresses/validate', { address })
  }

  /** What a letter would cost. Needs no key, but uses this client's base URL. */
  async quote(input: {
    destination: string
    pages?: number
    product?: Product
    colour?: boolean
    duplex?: boolean
  }): Promise<Quote> {
    return this.request<Quote>('POST', '/api/quote', input)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body)
    if (!res.ok) throw await this.toError(res)
    return (await res.json()) as T
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': `sendletter-node/${VERSION}`,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    return this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  private async toError(res: Response): Promise<SendLetterError> {
    let code = 'http_error'
    let message = `Request failed with ${res.status}`
    let details: Record<string, unknown> | undefined

    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> }
      }
      if (body.error) {
        code = body.error.code ?? code
        message = body.error.message ?? message
        details = body.error.details
      }
    } catch {
      // A gateway error page is not JSON, and the status is the whole story.
    }

    return new SendLetterError(code, message, res.status, details)
  }
}

/** The events a callback can carry. */
export type WebhookEventType =
  | 'letter.submitted'
  | 'letter.printed'
  | 'letter.posted'
  | 'letter.delivered'
  | 'letter.failed'
  | 'letter.refunded'

export interface WebhookEvent {
  /** Unique per event. Deduplicate on this: delivery is at-least-once. */
  id: string
  type: WebhookEventType
  sentAt: string
  letter: Letter
}

/**
 * Verifies a callback really came from us.
 *
 * The single most valuable thing in this package, because it is the step every
 * integrator has to implement and the one most often got wrong: comparing with
 * `===` leaks timing, parsing the body before verifying means verifying
 * something other than what arrived, and skipping it entirely means anyone who
 * learns the URL can tell your system a letter was delivered.
 *
 * Pass the raw request body, exactly as received. Not the parsed object, not a
 * re-serialised one: the signature covers those bytes and JSON.stringify does
 * not promise to reproduce them.
 */
export function verifyWebhook(input: {
  rawBody: string
  signature: string | null | undefined
  secret: string
  /** Reject anything older than this. Zero disables the check. */
  toleranceSeconds?: number
}): WebhookEvent {
  if (!input.signature) {
    throw new SendLetterError('invalid_signature', 'No signature header', 400)
  }

  const expected = createHmac('sha256', input.secret).update(input.rawBody, 'utf8').digest('hex')

  const a = Buffer.from(input.signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SendLetterError('invalid_signature', 'Signature does not match', 400)
  }

  let event: WebhookEvent
  try {
    event = JSON.parse(input.rawBody) as WebhookEvent
  } catch {
    throw new SendLetterError('invalid_request', 'Body is not JSON', 400)
  }

  const tolerance = input.toleranceSeconds ?? 5 * 60
  if (tolerance > 0) {
    const age = (Date.now() - Date.parse(event.sentAt)) / 1000
    if (!Number.isFinite(age) || Math.abs(age) > tolerance) {
      throw new SendLetterError('invalid_signature', 'Event is outside the accepted window', 400)
    }
  }

  return event
}
