/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface TurnstileRenderOptions {
  callback?: (token: string) => void
  'error-callback'?: () => void
  'expired-callback'?: () => void
  sitekey: string
  theme?: 'auto' | 'dark' | 'light'
}

interface TurnstileApi {
  remove?: (widgetId: string) => void
  render: (container: HTMLElement | string, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
}

interface Window {
  turnstile?: TurnstileApi
}
