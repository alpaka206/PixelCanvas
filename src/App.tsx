import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type SocketStatus = 'connecting' | 'live' | 'offline'
type VerificationMode = 'development' | 'turnstile'

interface Placement {
  color: string
  placedAt: number
  x: number
  y: number
}

interface VerificationState {
  enabled: boolean
  isVerified: boolean
  mode: VerificationMode
  siteKey: string | null
  verifiedUntil: number | null
}

interface BootstrapPayload {
  appName: string
  board: string
  boardHeight: number
  boardWidth: number
  connectedClients: number
  cooldownMs: number
  recentPlacements: Placement[]
  totalPlacements: number
  verification: VerificationState
  viewerCooldownRemainingMs: number
}

interface PlaceSuccessResponse {
  cooldownEndsAt: number
  ok: true
  placement: Placement
  totalPlacements: number
}

interface PlaceErrorResponse {
  code: string
  message: string
  ok: false
  retryAt?: number
}

type PlaceResponse = PlaceSuccessResponse | PlaceErrorResponse

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const DEFAULT_COLOR = '#161616'
const RECENT_COLOR_STORAGE_KEY = 'openpixel-recent-colors'
const DEFAULT_RECENT_COLORS = [
  '#161616',
  '#f4efe5',
  '#ff6b35',
  '#00a6a6',
  '#f7c948',
  '#2f855a',
  '#d64550',
  '#2b6cb0',
]

let turnstileScriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve()
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    )

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true })
      existingScript.addEventListener(
        'error',
        () => reject(new Error('Failed to load Turnstile script.')),
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Turnstile script.'))
    document.head.appendChild(script)
  })

  return turnstileScriptPromise
}

function decodeBoard(encodedBoard: string): Uint8ClampedArray {
  const binary = window.atob(encodedBoard)
  const bytes = new Uint8ClampedArray(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function sanitizeColor(input: string): string {
  const normalized = input.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/u.test(normalized) ? normalized : DEFAULT_COLOR
}

function hexToRgb(color: string): [number, number, number] {
  const normalized = sanitizeColor(color)
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ]
}

function upsertPlacement(placements: Placement[], nextPlacement: Placement): Placement[] {
  const deduped = placements.filter(
    (placement) =>
      !(
        placement.placedAt === nextPlacement.placedAt &&
        placement.x === nextPlacement.x &&
        placement.y === nextPlacement.y
      ),
  )

  return [nextPlacement, ...deduped].slice(0, 24)
}

function formatRelativeTime(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))

  if (deltaSeconds < 5) {
    return 'just now'
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`
  }

  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function readRecentColors(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_COLOR_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_RECENT_COLORS
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return DEFAULT_RECENT_COLORS
    }

    const uniqueColors = parsed
      .map((value) => sanitizeColor(String(value)))
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 12)

    return uniqueColors.length > 0 ? uniqueColors : DEFAULT_RECENT_COLORS
  } catch {
    return DEFAULT_RECENT_COLORS
  }
}

function persistRecentColor(color: string, currentColors: string[]): string[] {
  const normalized = sanitizeColor(color)
  const nextColors = [normalized, ...currentColors.filter((item) => item !== normalized)].slice(
    0,
    12,
  )
  window.localStorage.setItem(RECENT_COLOR_STORAGE_KEY, JSON.stringify(nextColors))
  return nextColors
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null)
  const turnstileWidgetIdRef = useRef<string | null>(null)

  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null)
  const [boardBytes, setBoardBytes] = useState<Uint8ClampedArray | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPlacing, setIsPlacing] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [localCooldownEndsAt, setLocalCooldownEndsAt] = useState(0)
  const [recentColors, setRecentColors] = useState<string[]>(() => readRecentColors())
  const [selectedColor, setSelectedColor] = useState(DEFAULT_COLOR)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting')
  const [statusMessage, setStatusMessage] = useState('Connecting to the board...')
  const [tick, setTick] = useState(() => Date.now())
  const [zoom, setZoom] = useState(6)

  const boardWidth = bootstrap?.boardWidth ?? 128
  const boardHeight = bootstrap?.boardHeight ?? 128
  const hasBootstrap = bootstrap !== null
  const verification = bootstrap?.verification ?? null
  const currentCooldownEndsAt = localCooldownEndsAt
  const cooldownRemainingMs = Math.max(0, currentCooldownEndsAt - tick)
  const cooldownRemainingSeconds = Math.ceil(cooldownRemainingMs / 1000)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTick(Date.now())
    }, 250)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (!canvasRef.current || !boardBytes) {
      return
    }

    const context = canvasRef.current.getContext('2d')
    if (!context) {
      return
    }

    const imageData = context.createImageData(boardWidth, boardHeight)
    for (let sourceIndex = 0, destinationIndex = 0; sourceIndex < boardBytes.length; sourceIndex += 3) {
      imageData.data[destinationIndex] = boardBytes[sourceIndex]
      imageData.data[destinationIndex + 1] = boardBytes[sourceIndex + 1]
      imageData.data[destinationIndex + 2] = boardBytes[sourceIndex + 2]
      imageData.data[destinationIndex + 3] = 255
      destinationIndex += 4
    }

    context.putImageData(imageData, 0, 0)
  }, [boardBytes, boardHeight, boardWidth])

  async function refreshBootstrap() {
    setIsLoading(true)
    setErrorMessage(null)

    try {
      const response = await fetch('/api/bootstrap', {
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`Bootstrap failed with status ${response.status}.`)
      }

      const payload = await readJson<BootstrapPayload>(response)
      setBootstrap(payload)
      setBoardBytes(decodeBoard(payload.board))
      setLocalCooldownEndsAt(Date.now() + payload.viewerCooldownRemainingMs)
      setStatusMessage(
        payload.verification.mode === 'development'
          ? 'Turnstile is disabled in local mode.'
          : 'Live board connected.',
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to load the collaborative board.'
      setErrorMessage(message)
      setStatusMessage('Board bootstrap failed.')
    } finally {
      setIsLoading(false)
    }
  }

  const updateBoardWithPlacement = useCallback((placement: Placement, totalPlacements?: number) => {
    setBoardBytes((currentBoard) => {
      if (!currentBoard) {
        return currentBoard
      }

      const nextBoard = new Uint8ClampedArray(currentBoard)
      const [red, green, blue] = hexToRgb(placement.color)
      const offset = (placement.y * boardWidth + placement.x) * 3

      nextBoard[offset] = red
      nextBoard[offset + 1] = green
      nextBoard[offset + 2] = blue

      return nextBoard
    })

    setBootstrap((currentBootstrap) => {
      if (!currentBootstrap) {
        return currentBootstrap
      }

      return {
        ...currentBootstrap,
        recentPlacements: upsertPlacement(currentBootstrap.recentPlacements, placement),
        totalPlacements: totalPlacements ?? currentBootstrap.totalPlacements,
      }
    })
  }, [boardWidth])

  useEffect(() => {
    void refreshBootstrap()
  }, [])

  useEffect(() => {
    if (!hasBootstrap) {
      return
    }

    let cancelled = false
    let socket: WebSocket | null = null

    const connect = () => {
      if (cancelled) {
        return
      }

      setSocketStatus('connecting')
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${wsProtocol}//${window.location.host}/ws`)

      socket.addEventListener('open', () => {
        if (cancelled) {
          return
        }

        setSocketStatus('live')
        setStatusMessage('Real-time sync is live.')
      })

      socket.addEventListener('message', (event) => {
        if (cancelled) {
          return
        }

        try {
          const payload = JSON.parse(String(event.data)) as
            | {
                connectedClients?: number
                placement?: Placement
                totalPlacements?: number
                type: 'pixel-updated' | 'presence'
              }
            | { type: 'pong' }

          if (payload.type === 'pixel-updated' && payload.placement) {
            updateBoardWithPlacement(payload.placement, payload.totalPlacements)
          }

          if (payload.type === 'presence') {
            setBootstrap((currentBootstrap) =>
              currentBootstrap
                ? {
                    ...currentBootstrap,
                    connectedClients:
                      payload.connectedClients ?? currentBootstrap.connectedClients,
                    totalPlacements:
                      payload.totalPlacements ?? currentBootstrap.totalPlacements,
                  }
                : currentBootstrap,
            )
          }
        } catch {
          setStatusMessage('Received an unreadable live update.')
        }
      })

      socket.addEventListener('close', () => {
        if (cancelled) {
          return
        }

        setSocketStatus('offline')
        setStatusMessage('Live sync dropped. Reconnecting...')
        reconnectTimerRef.current = window.setTimeout(connect, 1500)
      })

      socket.addEventListener('error', () => {
        if (cancelled) {
          return
        }

        setSocketStatus('offline')
        setStatusMessage('Live sync hit an error.')
      })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      socket?.close()
    }
  }, [boardHeight, boardWidth, hasBootstrap, updateBoardWithPlacement])

  useEffect(() => {
    if (
      !verification?.enabled ||
      verification.isVerified ||
      !verification.siteKey ||
      !turnstileContainerRef.current
    ) {
      return
    }

    let cancelled = false

    const renderTurnstile = async () => {
      try {
        await loadTurnstileScript()
        if (cancelled || !window.turnstile || !turnstileContainerRef.current) {
          return
        }

        turnstileContainerRef.current.innerHTML = ''
        turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: verification.siteKey!,
          theme: 'light',
          callback: async (token) => {
            setIsVerifying(true)
            setStatusMessage('Verifying session...')

            try {
              const response = await fetch('/api/verify', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ token }),
              })

              if (!response.ok) {
                const payload = await readJson<{ errors?: string[] }>(response)
                throw new Error(payload.errors?.join(', ') || 'Verification failed.')
              }

              const payload = await readJson<{ success: boolean; verifiedUntil: number }>(
                response,
              )
              if (!payload.success) {
                throw new Error('Verification failed.')
              }

              setBootstrap((currentBootstrap) =>
                currentBootstrap
                  ? {
                      ...currentBootstrap,
                      verification: {
                        ...currentBootstrap.verification,
                        isVerified: true,
                        verifiedUntil: payload.verifiedUntil,
                      },
                    }
                  : currentBootstrap,
              )
              setStatusMessage('Session verified. You can place pixels now.')
            } catch (error) {
              const message =
                error instanceof Error ? error.message : 'Verification was not accepted.'
              setStatusMessage(message)
              if (turnstileWidgetIdRef.current && window.turnstile) {
                window.turnstile.reset(turnstileWidgetIdRef.current)
              }
            } finally {
              setIsVerifying(false)
            }
          },
          'error-callback': () => {
            setStatusMessage('Turnstile failed. Please retry.')
          },
          'expired-callback': () => {
            setStatusMessage('Verification expired. Please retry.')
          },
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to load the verification widget.'
        setStatusMessage(message)
      }
    }

    void renderTurnstile()

    return () => {
      cancelled = true
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(turnstileWidgetIdRef.current)
      }
      turnstileWidgetIdRef.current = null
    }
  }, [verification])

  function updateHoverPosition(event: MouseEvent<HTMLCanvasElement>) {
    if (!bootstrap) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(
      boardWidth - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * boardWidth)),
    )
    const y = Math.min(
      boardHeight - 1,
      Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * boardHeight)),
    )

    setHoverCell({ x, y })
  }

  async function placePixel(x: number, y: number) {
    if (!bootstrap || isPlacing) {
      return
    }

    if (!bootstrap.verification.isVerified) {
      setStatusMessage('Verify this session before placing a pixel.')
      return
    }

    if (cooldownRemainingMs > 0) {
      setStatusMessage(`Cooldown active. Wait ${cooldownRemainingSeconds}s.`)
      return
    }

    setIsPlacing(true)
    setStatusMessage(`Placing ${selectedColor} at ${x}, ${y}...`)

    try {
      const response = await fetch('/api/place', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          color: selectedColor,
          x,
          y,
        }),
      })

      const payload = await readJson<PlaceResponse>(response)

      if (!response.ok || !payload.ok) {
        if (!payload.ok && payload.retryAt) {
          setLocalCooldownEndsAt(payload.retryAt)
        }

        if (
          !payload.ok &&
          payload.code === 'verification_required' &&
          bootstrap.verification.enabled
        ) {
          setBootstrap({
            ...bootstrap,
            verification: {
              ...bootstrap.verification,
              isVerified: false,
            },
          })
        }

        throw new Error(payload.ok ? 'Placement failed.' : payload.message)
      }

      updateBoardWithPlacement(payload.placement, payload.totalPlacements)
      setLocalCooldownEndsAt(payload.cooldownEndsAt)
      setRecentColors((currentColors) => persistRecentColor(selectedColor, currentColors))
      setStatusMessage(
        `Placed ${payload.placement.color} at (${payload.placement.x}, ${payload.placement.y}).`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Placement failed.'
      setStatusMessage(message)
    } finally {
      setIsPlacing(false)
    }
  }

  const overlayStyle = {
    backgroundImage:
      'linear-gradient(to right, rgba(22, 22, 22, 0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(22, 22, 22, 0.08) 1px, transparent 1px)',
    backgroundSize: `${zoom}px ${zoom}px`,
  }

  const hoverStyle =
    hoverCell === null
      ? undefined
      : {
          height: `${zoom}px`,
          transform: `translate(${hoverCell.x * zoom}px, ${hoverCell.y * zoom}px)`,
          width: `${zoom}px`,
        }

  return (
    <div className="app-shell">
      <div className="app-glow app-glow-left" />
      <div className="app-glow app-glow-right" />

      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Public Beta / Cloudflare Workers</p>
          <h1>{bootstrap?.appName ?? 'OpenPixel Beta'}</h1>
          <p className="hero-body">
            A single collaborative canvas with free color picking, durable board state, and
            real-time fanout over Durable Objects.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="metric-card">
            <span className="metric-label">Sockets</span>
            <strong>{bootstrap?.connectedClients ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Placements</span>
            <strong>{bootstrap?.totalPlacements ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Cooldown</span>
            <strong>{bootstrap ? `${Math.round(bootstrap.cooldownMs / 1000)}s` : '--'}</strong>
          </div>
        </div>
      </header>

      <main className="dashboard">
        <section className="board-panel panel">
          <div className="panel-head">
            <div>
              <p className="panel-label">Board</p>
              <h2>
                {boardWidth} x {boardHeight} collaborative canvas
              </h2>
            </div>
            <div className={`status-pill status-${socketStatus}`}>
              <span className="status-dot" />
              {socketStatus}
            </div>
          </div>

          <div className="board-toolbar">
            <label className="toolbar-group">
              <span>Zoom</span>
              <input
                type="range"
                min={4}
                max={12}
                step={1}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>

            <div className="toolbar-group">
              <span>Cursor</span>
              <strong>{hoverCell ? `${hoverCell.x}, ${hoverCell.y}` : 'Hover the board'}</strong>
            </div>

            <div className="toolbar-group">
              <span>Selected color</span>
              <strong>{selectedColor}</strong>
            </div>
          </div>

          <div className="board-stage">
            {isLoading ? (
              <div className="board-placeholder">Loading board state...</div>
            ) : errorMessage ? (
              <div className="board-placeholder board-error">
                <p>{errorMessage}</p>
                <button type="button" onClick={() => void refreshBootstrap()}>
                  Retry bootstrap
                </button>
              </div>
            ) : (
              <div className="board-scroll">
                <div
                  className="board-wrap"
                  style={{ height: boardHeight * zoom, width: boardWidth * zoom }}
                >
                  <canvas
                    ref={canvasRef}
                    className="pixel-board"
                    height={boardHeight}
                    width={boardWidth}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      const x = Math.min(
                        boardWidth - 1,
                        Math.max(
                          0,
                          Math.floor(((event.clientX - rect.left) / rect.width) * boardWidth),
                        ),
                      )
                      const y = Math.min(
                        boardHeight - 1,
                        Math.max(
                          0,
                          Math.floor(((event.clientY - rect.top) / rect.height) * boardHeight),
                        ),
                      )

                      void placePixel(x, y)
                    }}
                    onMouseLeave={() => setHoverCell(null)}
                    onMouseMove={updateHoverPosition}
                    style={{ height: boardHeight * zoom, width: boardWidth * zoom }}
                  />
                  <div className="board-grid" style={overlayStyle} />
                  {hoverStyle ? <div className="board-hover" style={hoverStyle} /> : null}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="sidebar">
          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Controls</p>
                <h2>Place pixels fast</h2>
              </div>
            </div>

            <label className="color-picker-card">
              <span>Free color selection</span>
              <div className="color-picker-row">
                <input
                  aria-label="Select color"
                  className="native-color-input"
                  type="color"
                  value={selectedColor}
                  onChange={(event) => setSelectedColor(sanitizeColor(event.target.value))}
                />
                <input
                  aria-label="Hex color"
                  className="hex-input"
                  type="text"
                  maxLength={7}
                  value={selectedColor}
                  onChange={(event) => setSelectedColor(sanitizeColor(event.target.value))}
                />
              </div>
            </label>

            <div className="swatch-section">
              <div className="swatch-head">
                <span>Recent swatches</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRecentColors(DEFAULT_RECENT_COLORS)}
                >
                  reset
                </button>
              </div>

              <div className="swatch-grid">
                {recentColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`swatch ${selectedColor === color ? 'is-active' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setSelectedColor(color)}
                    title={color}
                  />
                ))}
              </div>
            </div>

            <div className="control-note">
              <span>Cooldown</span>
              <strong>
                {cooldownRemainingMs > 0 ? `${cooldownRemainingSeconds}s remaining` : 'Ready now'}
              </strong>
            </div>

            <p className="status-message">{statusMessage}</p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Verification</p>
                <h2>Public beta guardrails</h2>
              </div>
            </div>

            {bootstrap?.verification.mode === 'development' ? (
              <div className="notice success">
                Turnstile is disabled because the worker secrets are not configured locally.
              </div>
            ) : bootstrap?.verification.isVerified ? (
              <div className="notice success">
                Session verified
                {bootstrap.verification.verifiedUntil
                  ? ` until ${new Date(bootstrap.verification.verifiedUntil).toLocaleTimeString()}`
                  : ''}
                .
              </div>
            ) : (
              <>
                <p className="supporting-copy">
                  Complete the Turnstile check once, then keep placing pixels until the verification
                  window expires.
                </p>
                <div ref={turnstileContainerRef} className="turnstile-slot" />
                {isVerifying ? <p className="supporting-copy">Verifying...</p> : null}
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Activity</p>
                <h2>Latest placements</h2>
              </div>
            </div>

            <div className="activity-list">
              {bootstrap?.recentPlacements.length ? (
                bootstrap.recentPlacements.map((placement) => (
                  <div
                    key={`${placement.placedAt}-${placement.x}-${placement.y}`}
                    className="activity-item"
                  >
                    <span
                      className="activity-color"
                      style={{ backgroundColor: placement.color }}
                    />
                    <div>
                      <strong>
                        ({placement.x}, {placement.y}) {placement.color}
                      </strong>
                      <p>{formatRelativeTime(placement.placedAt)}</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="supporting-copy">No placements yet. Claim the first pixel.</p>
              )}
            </div>
          </section>
        </aside>
      </main>
    </div>
  )
}

export default App
