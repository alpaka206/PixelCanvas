import { DurableObject } from 'cloudflare:workers'

interface Placement {
  color: string
  placedAt: number
  x: number
  y: number
}

interface BoardBootstrapPayload {
  board: string
  boardHeight: number
  boardWidth: number
  connectedClients: number
  cooldownMs: number
  recentPlacements: Placement[]
  totalPlacements: number
  viewerCooldownRemainingMs: number
}

interface BoardPlaceRequest {
  actorKey: string
  color: string
  x: number
  y: number
}

interface BoardPlaceSuccessResponse {
  cooldownEndsAt: number
  ok: true
  placement: Placement
  totalPlacements: number
}

interface BoardPlaceErrorResponse {
  code: string
  message: string
  ok: false
  retryAt?: number
}

interface AppConfig {
  appName: string
  boardHeight: number
  boardWidth: number
  cooldownMs: number
  recentPlacementsLimit: number
  verificationTtlMs: number
}

interface VerificationState {
  enabled: boolean
  isVerified: boolean
  mode: 'development' | 'turnstile'
  siteKey: string | null
  verifiedUntil: number | null
}

export interface Env {
  APP_NAME?: string
  BOARD_HEIGHT?: string
  BOARD_ROOM: DurableObjectNamespace
  BOARD_WIDTH?: string
  COOKIE_SECRET?: string
  PLACEMENT_COOLDOWN_MS?: string
  RECENT_PLACEMENTS_LIMIT?: string
  TURNSTILE_SECRET?: string
  TURNSTILE_SITE_KEY?: string
  VERIFICATION_TTL_MS?: string
}

const BOARD_NAME = 'main'
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu
const SESSION_COOKIE = '__openpixel_session'
const VERIFIED_COOKIE = '__openpixel_verified'

function getConfig(env: Env): AppConfig {
  return {
    appName: env.APP_NAME?.trim() || 'OpenPixel Beta',
    boardHeight: clampNumber(env.BOARD_HEIGHT, 128, 32, 256),
    boardWidth: clampNumber(env.BOARD_WIDTH, 128, 32, 256),
    cooldownMs: clampNumber(env.PLACEMENT_COOLDOWN_MS, 20_000, 5_000, 300_000),
    recentPlacementsLimit: clampNumber(env.RECENT_PLACEMENTS_LIMIT, 24, 8, 60),
    verificationTtlMs: clampNumber(env.VERIFICATION_TTL_MS, 21_600_000, 60_000, 86_400_000),
  }
}

function clampNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, parsed))
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) {
    return {}
  }

  return header
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, entry) => {
      const separatorIndex = entry.indexOf('=')
      if (separatorIndex === -1) {
        return cookies
      }

      cookies[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1)
      return cookies
    }, {})
}

function getCookieSecret(env: Env): string {
  return env.COOKIE_SECRET || env.TURNSTILE_SECRET || 'openpixel-local-dev-secret'
}

function buildCookie(
  request: Request,
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}

function clearCookie(request: Request, name: string): string {
  return buildCookie(request, name, '', 0)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const value of bytes) {
    binary += String.fromCharCode(value)
  }

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...slice)
  }

  return btoa(binary)
}

async function signValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return toBase64Url(new Uint8Array(signature))
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }

  return difference === 0
}

async function buildVerifiedCookie(
  request: Request,
  env: Env,
  sessionId: string,
  verifiedUntil: number,
): Promise<string> {
  const payload = `${sessionId}.${verifiedUntil}`
  const signature = await signValue(getCookieSecret(env), payload)
  const ttlSeconds = Math.max(0, Math.ceil((verifiedUntil - Date.now()) / 1000))
  return buildCookie(request, VERIFIED_COOKIE, `${verifiedUntil}.${signature}`, ttlSeconds)
}

async function readVerificationState(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<VerificationState & { clearCookie: boolean }> {
  const enabled = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET)
  if (!enabled) {
    return {
      clearCookie: false,
      enabled: false,
      isVerified: true,
      mode: 'development',
      siteKey: null,
      verifiedUntil: null,
    }
  }

  const value = parseCookies(request.headers.get('Cookie'))[VERIFIED_COOKIE]
  if (!value) {
    return {
      clearCookie: false,
      enabled: true,
      isVerified: false,
      mode: 'turnstile',
      siteKey: env.TURNSTILE_SITE_KEY ?? null,
      verifiedUntil: null,
    }
  }

  const [verifiedUntilRaw, signature] = value.split('.', 2)
  const verifiedUntil = Number.parseInt(verifiedUntilRaw ?? '', 10)
  if (!Number.isFinite(verifiedUntil) || !signature || verifiedUntil <= Date.now()) {
    return {
      clearCookie: true,
      enabled: true,
      isVerified: false,
      mode: 'turnstile',
      siteKey: env.TURNSTILE_SITE_KEY ?? null,
      verifiedUntil: null,
    }
  }

  const expectedSignature = await signValue(
    getCookieSecret(env),
    `${sessionId}.${verifiedUntil}`,
  )

  if (!constantTimeEqual(signature, expectedSignature)) {
    return {
      clearCookie: true,
      enabled: true,
      isVerified: false,
      mode: 'turnstile',
      siteKey: env.TURNSTILE_SITE_KEY ?? null,
      verifiedUntil: null,
    }
  }

  return {
    clearCookie: false,
    enabled: true,
    isVerified: true,
    mode: 'turnstile',
    siteKey: env.TURNSTILE_SITE_KEY ?? null,
    verifiedUntil,
  }
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  )
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  )
}

async function getActorKey(request: Request, sessionId: string): Promise<string> {
  const userAgent = request.headers.get('User-Agent') || 'unknown'
  return sha256Hex(`${sessionId}|${getClientIp(request)}|${userAgent.slice(0, 160)}`)
}

function normalizeColor(color: string): string | null {
  const normalized = color.trim().toLowerCase()
  return COLOR_PATTERN.test(normalized) ? normalized : null
}

async function validateTurnstile(
  token: string,
  request: Request,
  secret: string,
): Promise<{ errors: string[]; success: boolean }> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      remoteip: getClientIp(request),
      response: token,
      secret,
    }),
  })

  const payload = (await response.json()) as { 'error-codes'?: string[]; success?: boolean }
  return {
    errors: payload['error-codes'] ?? [],
    success: Boolean(payload.success),
  }
}

function appendCookies(response: Response, cookies: string[]): Response {
  if (cookies.length === 0) {
    return response
  }

  const headers = new Headers(response.headers)
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie)
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

async function withSession(
  request: Request,
): Promise<{ cookiesToSet: string[]; sessionId: string }> {
  const existingSession = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE]
  if (existingSession) {
    return { cookiesToSet: [], sessionId: existingSession }
  }

  const sessionId = crypto.randomUUID()
  return {
    cookiesToSet: [buildCookie(request, SESSION_COOKIE, sessionId, 31_536_000)],
    sessionId,
  }
}

async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const { cookiesToSet, sessionId } = await withSession(request)
  const verification = await readVerificationState(request, env, sessionId)
  const boardStub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(BOARD_NAME))
  const boardResponse = await boardStub.fetch('https://board.internal/bootstrap', {
    headers: {
      'X-Actor-Key': await getActorKey(request, sessionId),
    },
  })

  const payload = (await boardResponse.json()) as BoardBootstrapPayload
  const response = json({
    ...payload,
    appName: getConfig(env).appName,
    verification: {
      enabled: verification.enabled,
      isVerified: verification.isVerified,
      mode: verification.mode,
      siteKey: verification.siteKey,
      verifiedUntil: verification.verifiedUntil,
    },
  })

  return appendCookies(
    response,
    verification.clearCookie
      ? [...cookiesToSet, clearCookie(request, VERIFIED_COOKIE)]
      : cookiesToSet,
  )
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const { cookiesToSet, sessionId } = await withSession(request)
  const config = getConfig(env)

  if (!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY)) {
    const verifiedUntil = Date.now() + config.verificationTtlMs
    return appendCookies(
      json({
        mode: 'development',
        success: true,
        verifiedUntil,
      }),
      [...cookiesToSet, await buildVerifiedCookie(request, env, sessionId, verifiedUntil)],
    )
  }

  const body = (await request.json().catch(() => null)) as { token?: string } | null
  const token = body?.token?.trim()
  if (!token) {
    return appendCookies(
      json(
        {
          errors: ['missing-token'],
          success: false,
        },
        { status: 400 },
      ),
      cookiesToSet,
    )
  }

  const validation = await validateTurnstile(token, request, env.TURNSTILE_SECRET)
  if (!validation.success) {
    return appendCookies(
      json(
        {
          errors: validation.errors,
          success: false,
        },
        { status: 403 },
      ),
      cookiesToSet,
    )
  }

  const verifiedUntil = Date.now() + config.verificationTtlMs
  return appendCookies(
    json({
      mode: 'turnstile',
      success: true,
      verifiedUntil,
    }),
    [...cookiesToSet, await buildVerifiedCookie(request, env, sessionId, verifiedUntil)],
  )
}

async function handlePlace(request: Request, env: Env): Promise<Response> {
  const { cookiesToSet, sessionId } = await withSession(request)
  const verification = await readVerificationState(request, env, sessionId)

  if (!verification.isVerified) {
    return appendCookies(
      json(
        {
          code: 'verification_required',
          message: 'Verify this session before placing pixels.',
          ok: false,
        } satisfies BoardPlaceErrorResponse,
        { status: 403 },
      ),
      [...cookiesToSet, clearCookie(request, VERIFIED_COOKIE)],
    )
  }

  const body = (await request.json().catch(() => null)) as
    | Partial<BoardPlaceRequest>
    | null
  const normalizedColor = normalizeColor(String(body?.color ?? ''))
  const x = Number.parseInt(String(body?.x ?? ''), 10)
  const y = Number.parseInt(String(body?.y ?? ''), 10)

  if (!normalizedColor || !Number.isInteger(x) || !Number.isInteger(y)) {
    return appendCookies(
      json(
        {
          code: 'invalid_payload',
          message: 'Invalid placement payload.',
          ok: false,
        } satisfies BoardPlaceErrorResponse,
        { status: 400 },
      ),
      cookiesToSet,
    )
  }

  const boardStub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(BOARD_NAME))
  const response = await boardStub.fetch('https://board.internal/place', {
    body: JSON.stringify({
      actorKey: await getActorKey(request, sessionId),
      color: normalizedColor,
      x,
      y,
    } satisfies BoardPlaceRequest),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  return appendCookies(response, cookiesToSet)
}

function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const boardStub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(BOARD_NAME))
  return boardStub.fetch(new Request('https://board.internal/ws', request))
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      return handleBootstrap(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/verify') {
      return handleVerify(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/place') {
      return handlePlace(request, env)
    }

    if (url.pathname === '/ws') {
      return handleWebSocket(request, env)
    }

    return json(
      {
        error: 'not_found',
      },
      { status: 404 },
    )
  },
} satisfies ExportedHandler<Env>

function createEmptyBoard(width: number, height: number): Uint8Array {
  const board = new Uint8Array(width * height * 3)
  board.fill(255)
  return board
}

export class BoardRoom extends DurableObject {
  private board: Uint8Array = createEmptyBoard(1, 1)
  private readonly config: AppConfig
  private recentPlacements: Placement[] = []
  private readonly ready: Promise<void>
  private totalPlacements = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.config = getConfig(env)
    this.ready = this.loadState()
  }

  private get expectedBoardByteLength(): number {
    return this.config.boardWidth * this.config.boardHeight * 3
  }

  private async loadState(): Promise<void> {
    const storedBoard = await this.ctx.storage.get<Uint8Array>('board')
    const storedPlacements = await this.ctx.storage.get<Placement[]>('recentPlacements')
    const storedTotal = await this.ctx.storage.get<number>('totalPlacements')

    this.board =
      storedBoard && storedBoard.byteLength === this.expectedBoardByteLength
        ? storedBoard
        : createEmptyBoard(this.config.boardWidth, this.config.boardHeight)
    this.recentPlacements = Array.isArray(storedPlacements) ? storedPlacements : []
    this.totalPlacements = typeof storedTotal === 'number' ? storedTotal : 0
  }

  private getConnectedClients(): number {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === 1).length
  }

  private async getCooldownRemaining(actorKey: string): Promise<number> {
    const cooldownUntil = (await this.ctx.storage.get<number>(`cooldown:${actorKey}`)) ?? 0
    return Math.max(0, cooldownUntil - Date.now())
  }

  private broadcast(message: unknown): void {
    const payload = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        // Best-effort fanout only.
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({
      connectedClients: this.getConnectedClients(),
      totalPlacements: this.totalPlacements,
      type: 'presence',
    })
  }

  private setPixel(x: number, y: number, color: string): void {
    const offset = (y * this.config.boardWidth + x) * 3
    this.board[offset] = Number.parseInt(color.slice(1, 3), 16)
    this.board[offset + 1] = Number.parseInt(color.slice(3, 5), 16)
    this.board[offset + 2] = Number.parseInt(color.slice(5, 7), 16)
  }

  private handleBootstrap(request: Request): Promise<Response> {
    const actorKey = request.headers.get('X-Actor-Key')
    const getPayload = async () =>
      json({
        board: encodeBytesToBase64(this.board),
        boardHeight: this.config.boardHeight,
        boardWidth: this.config.boardWidth,
        connectedClients: this.getConnectedClients(),
        cooldownMs: this.config.cooldownMs,
        recentPlacements: this.recentPlacements,
        totalPlacements: this.totalPlacements,
        viewerCooldownRemainingMs: actorKey ? await this.getCooldownRemaining(actorKey) : 0,
      } satisfies BoardBootstrapPayload)

    return getPayload()
  }

  private async handlePlace(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Partial<BoardPlaceRequest> | null
    const normalizedColor = normalizeColor(String(body?.color ?? ''))
    const x = Number.parseInt(String(body?.x ?? ''), 10)
    const y = Number.parseInt(String(body?.y ?? ''), 10)
    const actorKey = String(body?.actorKey ?? '')

    if (
      !normalizedColor ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.config.boardWidth ||
      y >= this.config.boardHeight ||
      actorKey.length < 12
    ) {
      return json(
        {
          code: 'invalid_payload',
          message: 'The placement payload is invalid.',
          ok: false,
        } satisfies BoardPlaceErrorResponse,
        { status: 400 },
      )
    }

    const cooldownKey = `cooldown:${actorKey}`
    const retryAt = (await this.ctx.storage.get<number>(cooldownKey)) ?? 0
    if (retryAt > Date.now()) {
      return json(
        {
          code: 'cooldown',
          message: 'This session is still cooling down.',
          ok: false,
          retryAt,
        } satisfies BoardPlaceErrorResponse,
        { status: 429 },
      )
    }

    const placedAt = Date.now()
    const cooldownEndsAt = placedAt + this.config.cooldownMs
    const placement: Placement = {
      color: normalizedColor,
      placedAt,
      x,
      y,
    }

    this.setPixel(x, y, normalizedColor)
    this.recentPlacements = [
      placement,
      ...this.recentPlacements.filter(
        (entry) => !(entry.x === x && entry.y === y && entry.placedAt === placedAt),
      ),
    ].slice(0, this.config.recentPlacementsLimit)
    this.totalPlacements += 1

    await Promise.all([
      this.ctx.storage.put('board', this.board.slice()),
      this.ctx.storage.put('recentPlacements', this.recentPlacements),
      this.ctx.storage.put('totalPlacements', this.totalPlacements),
      this.ctx.storage.put(cooldownKey, cooldownEndsAt),
    ])

    this.broadcast({
      placement,
      totalPlacements: this.totalPlacements,
      type: 'pixel-updated',
    })

    return json({
      cooldownEndsAt,
      ok: true,
      placement,
      totalPlacements: this.totalPlacements,
    } satisfies BoardPlaceSuccessResponse)
  }

  private handleWebSocket(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade.', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)

    server.send(
      JSON.stringify({
        connectedClients: this.getConnectedClients(),
        totalPlacements: this.totalPlacements,
        type: 'presence',
      }),
    )
    this.broadcastPresence()

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/bootstrap') {
      return this.handleBootstrap(request)
    }

    if (request.method === 'POST' && url.pathname === '/place') {
      return this.handlePlace(request)
    }

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request)
    }

    return json(
      {
        error: 'not_found',
      },
      { status: 404 },
    )
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence()
  }

  async webSocketError(): Promise<void> {
    this.broadcastPresence()
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string' && message === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }))
    }
  }
}
